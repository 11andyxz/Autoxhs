import { createHash } from "crypto";

import type { RowDataPacket } from "mysql2";

import { getClient, MissingApiKeyError } from "@/lib/openai";
import { getPool } from "@/lib/serviceFee/db";
import type { IndeedQuestion } from "@/lib/indeed/service";

/**
 * Indeed 雇主问题「个人知识库」。
 *
 * 目标:用户手动答过的问题 + 答案沉淀进库,下次遇到:
 *  - 归一化后**完全相同**的问题 → 精确命中,自动作答(source=exact)。
 *  - 语义**相似**的问题 → 用 OpenAI 向量做相似度匹配,命中则预填、但标记为 similar 让用户过目。
 *
 * 存储复用共享 MySQL 池(lib/serviceFee/db)。无鉴权、单用户,与 /employee 一致的取舍。
 */

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
// 语义相似阈值:余弦相似度 ≥ 此值才算「相似命中」。偏保守,避免误配。
const SIMILAR_THRESHOLD = 0.86;
const MAX_KB_ROWS = 2000; // 语义匹配时最多载入的候选行数(个人库远小于此)

let kbSchemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。 */
export function ensureKbSchema(): Promise<void> {
  if (kbSchemaReady) return kbSchemaReady;
  kbSchemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS indeed_qa_kb (
        id INT AUTO_INCREMENT PRIMARY KEY,
        q_hash CHAR(64) NOT NULL UNIQUE,
        q_text TEXT NOT NULL,
        q_type VARCHAR(40) NOT NULL DEFAULT '',
        options_json JSON NULL,
        answer_value VARCHAR(2048) NOT NULL,
        answer_label VARCHAR(2048) NULL,
        embedding MEDIUMTEXT NULL,
        hit_count INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  })();
  return kbSchemaReady;
}

/** 问题文本归一化:去 HTML 标签 → 小写 → 去标点 → 合并空白。用于精确匹配与向量输入。 */
export function normalizeQuestionText(label: string): string {
  return (label || "")
    .replace(/<[^>]*>/g, " ") // 去 HTML 标签
    .replace(/&[a-z]+;/gi, " ") // 去 HTML 实体
    .toLowerCase()
    .replace(/['’`]/g, "") // 撇号直接删除(driver's→drivers、don't→dont),避免拆词
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // 其余标点→空格(保留字母/数字/空白,含 CJK)
    .replace(/\s+/g, " ")
    .trim();
}

function questionHash(normText: string): string {
  return createHash("sha256").update(normText).digest("hex");
}

export type KbMatch = {
  questionId: string;
  source: "exact" | "similar";
  value: string;
  valueLabel: string | null;
  confidence: number; // exact=1;similar=余弦相似度
};

export type KbSaveItem = {
  label: string;
  type: string;
  options: Array<{ value: string; label: string }> | null;
  value: string;
  valueLabel?: string | null;
};

type KbRow = RowDataPacket & {
  q_hash: string;
  q_text: string;
  q_type: string;
  options_json: string | null;
  answer_value: string;
  answer_label: string | null;
  embedding: string | null;
};

/**
 * 把库里的一条答案解析成「对当前这道题合法」的值。
 * - 无选项(自由文本/数字):直接用库里的值。
 * - 有选项:先按 value 命中当前选项;否则按 label(忽略大小写)命中;都不行 → null(不能安全套用)。
 */
export function resolveValue(
  question: Pick<IndeedQuestion, "options">,
  row: { answer_value: string; answer_label: string | null },
): { value: string; valueLabel: string | null } | null {
  const opts = question.options;
  if (!opts || opts.length === 0) {
    return { value: row.answer_value, valueLabel: null };
  }
  const byValue = opts.find((o) => o.value === row.answer_value);
  if (byValue) return { value: byValue.value, valueLabel: byValue.label };
  const lbl = (row.answer_label || "").trim().toLowerCase();
  if (lbl) {
    const byLabel = opts.find((o) => o.label.trim().toLowerCase() === lbl);
    if (byLabel) return { value: byLabel.value, valueLabel: byLabel.label };
  }
  return null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 批量向量化;无 API Key 或调用失败时返回全 null(优雅降级为「仅精确匹配」)。 */
async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  if (!texts.length) return [];
  try {
    const client = getClient(30_000);
    const res = await client.embeddings.create({ model: EMBED_MODEL, input: texts });
    return texts.map((_, i) => res.data[i]?.embedding ?? null);
  } catch (err) {
    if (err instanceof MissingApiKeyError) return texts.map(() => null);
    // 其余错误(限流/网络等)也降级,不阻断答题流程
    return texts.map(() => null);
  }
}

/**
 * 为一批雇主问题匹配知识库答案。返回按 questionId 索引的命中(未命中的题不出现在结果里)。
 * 任一环节(建表/查询/向量)出错都吞掉,返回已得到的结果,绝不阻断答题。
 */
export async function matchQuestions(
  questions: IndeedQuestion[],
): Promise<Record<string, KbMatch>> {
  const out: Record<string, KbMatch> = {};
  const valid = questions.filter((q) => q.id && q.label);
  if (!valid.length) return out;

  try {
    await ensureKbSchema();
    const pool = getPool();

    // 1) 精确匹配:归一化 → hash → IN 查询
    const normByQid = new Map<string, string>();
    const hashByQid = new Map<string, string>();
    for (const q of valid) {
      const norm = normalizeQuestionText(q.label);
      normByQid.set(q.id, norm);
      hashByQid.set(q.id, questionHash(norm));
    }
    const uniqueHashes = [...new Set(hashByQid.values())];
    const exactRows = new Map<string, KbRow>();
    if (uniqueHashes.length) {
      const [rows] = await pool.query<KbRow[]>(
        `SELECT q_hash, q_text, q_type, options_json, answer_value, answer_label, embedding
           FROM indeed_qa_kb WHERE q_hash IN (${uniqueHashes.map(() => "?").join(",")})`,
        uniqueHashes,
      );
      for (const r of rows) exactRows.set(r.q_hash, r);
    }

    const unmatched: IndeedQuestion[] = [];
    for (const q of valid) {
      const row = exactRows.get(hashByQid.get(q.id)!);
      if (row) {
        const resolved = resolveValue(q, row);
        if (resolved) {
          out[q.id] = { questionId: q.id, source: "exact", ...resolved, confidence: 1 };
          continue;
        }
      }
      unmatched.push(q);
    }

    if (!unmatched.length) return out;

    // 2) 语义相似:向量化未精确命中的题,与库内向量做余弦
    const [allRows] = await pool.query<KbRow[]>(
      `SELECT q_hash, q_text, q_type, options_json, answer_value, answer_label, embedding
         FROM indeed_qa_kb WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ${MAX_KB_ROWS}`,
    );
    const candidates = allRows
      .map((r) => {
        try {
          return { row: r, vec: JSON.parse(r.embedding as string) as number[] };
        } catch {
          return null;
        }
      })
      .filter((x): x is { row: KbRow; vec: number[] } => !!x && Array.isArray(x.vec) && x.vec.length > 0);
    if (!candidates.length) return out;

    const queryVecs = await embedTexts(unmatched.map((q) => normByQid.get(q.id)!));
    unmatched.forEach((q, i) => {
      const qv = queryVecs[i];
      if (!qv) return;
      let best: { row: KbRow; score: number } | null = null;
      for (const c of candidates) {
        // 同类型才比,降低误配(例如别把 NUMBER 题配到 RADIO 题)
        if (q.type && c.row.q_type && q.type !== c.row.q_type) continue;
        const score = cosine(qv, c.vec);
        if (!best || score > best.score) best = { row: c.row, score };
      }
      if (best && best.score >= SIMILAR_THRESHOLD) {
        const resolved = resolveValue(q, best.row);
        if (resolved) {
          out[q.id] = {
            questionId: q.id,
            source: "similar",
            ...resolved,
            confidence: Number(best.score.toFixed(4)),
          };
        }
      }
    });

    return out;
  } catch {
    return out; // DB 不可用等:不阻断,前端全部按「需你填写」处理
  }
}

/** 保存/更新一批「问题→答案」到知识库(仅存有值的)。按归一化文本的 hash 去重 upsert。 */
export async function saveAnswers(items: KbSaveItem[]): Promise<number> {
  const usable = items.filter((it) => it.label?.trim() && String(it.value ?? "").length > 0);
  if (!usable.length) return 0;

  await ensureKbSchema();
  const pool = getPool();

  const norms = usable.map((it) => normalizeQuestionText(it.label));
  const embeds = await embedTexts(norms);

  let saved = 0;
  for (let i = 0; i < usable.length; i++) {
    const it = usable[i];
    const norm = norms[i];
    if (!norm) continue;
    const hash = questionHash(norm);
    const emb = embeds[i];
    await pool.query(
      `INSERT INTO indeed_qa_kb (q_hash, q_text, q_type, options_json, answer_value, answer_label, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         q_text = VALUES(q_text), q_type = VALUES(q_type), options_json = VALUES(options_json),
         answer_value = VALUES(answer_value), answer_label = VALUES(answer_label),
         embedding = COALESCE(VALUES(embedding), embedding),
         updated_at = CURRENT_TIMESTAMP`,
      [
        hash,
        it.label,
        it.type || "",
        it.options ? JSON.stringify(it.options) : null,
        String(it.value),
        it.valueLabel ?? null,
        emb ? JSON.stringify(emb) : null,
      ],
    );
    saved += 1;
  }
  return saved;
}
