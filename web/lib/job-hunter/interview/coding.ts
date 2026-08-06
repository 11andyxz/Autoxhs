import { createHash } from "node:crypto";

import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

import { srStateFromStability, type SrState } from "./fsrs";

/**
 * 「Coding 手感训练」的持久化层。与面试题库(repo.ts)、简历猛攻(cram.ts)相互独立:
 * - ip_coding_problem:一道跟打题(题干 + 上下文 + 参考代码 + 讲解),带 FSRS 遗忘曲线列
 *   和手速/正确率的历史最佳,按 problem_hash 去重(同一题不会重复入库)。
 * - ip_coding_attempt:每敲完一遍的一条记录(wpm / 正确率 / 用时 / 错字数),用于看进步曲线。
 * 复用同一个 Aiven 连接池(getPool),表加 ip_coding_ 前缀,建在同一 defaultdb。
 */

export const CODING_CATEGORIES = ["java-lambda", "mysql", "mongodb", "design", "algorithm"] as const;
export type CodingCategory = (typeof CODING_CATEGORIES)[number];

export const CODING_LANGS = ["java", "sql", "javascript"] as const;
export type CodingLang = (typeof CODING_LANGS)[number];

export function isCodingCategory(v: unknown): v is CodingCategory {
  return typeof v === "string" && (CODING_CATEGORIES as readonly string[]).includes(v);
}

/** 每类题默认用的语言(模型偶尔填错时兜底) */
export const DEFAULT_LANG: Record<CodingCategory, CodingLang> = {
  "java-lambda": "java",
  mysql: "sql",
  mongodb: "javascript",
  design: "java",
  algorithm: "java",
};

/** 去重键:同一分类下标题归一化后相同 = 同一道题(大小写/标点/空格不敏感)。 */
export function problemHash(category: string, title: string): string {
  const key = title
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return createHash("sha256").update(`${category}|${key}`).digest("hex");
}

let codingSchemaReady: Promise<void> | null = null;

/** 执行 DDL,忽略「列/键已存在」等可安全重跑的错误码。 */
async function execIgnoring(sql: string, ignoreCodes: string[]): Promise<void> {
  const p = getPool();
  try {
    await p.query(sql);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (!code || !ignoreCodes.includes(code)) throw err;
  }
}

export function ensureCodingSchema(): Promise<void> {
  if (codingSchemaReady) return codingSchemaReady;
  codingSchemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_coding_problem (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(24) NOT NULL DEFAULT 'java-lambda',
        lang VARCHAR(16) NOT NULL DEFAULT 'java',
        title VARCHAR(255) NOT NULL,
        prompt MEDIUMTEXT NOT NULL,
        prompt_en MEDIUMTEXT NULL,
        setup MEDIUMTEXT NULL,
        solution MEDIUMTEXT NOT NULL,
        explanation MEDIUMTEXT NULL,
        difficulty TINYINT NOT NULL DEFAULT 2,
        source VARCHAR(16) NOT NULL DEFAULT 'ai',
        problem_hash CHAR(64) NOT NULL,
        runs INT NOT NULL DEFAULT 0,
        best_wpm INT NOT NULL DEFAULT 0,
        best_accuracy INT NOT NULL DEFAULT 0,
        last_wpm INT NOT NULL DEFAULT 0,
        last_accuracy INT NOT NULL DEFAULT 0,
        interval_days INT NOT NULL DEFAULT 0,
        repetitions INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        fsrs_difficulty DOUBLE NULL,
        fsrs_stability DOUBLE NULL,
        fsrs_state TINYINT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        last_reviewed_at DATETIME NULL,
        last_grade VARCHAR(10) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_ip_coding_hash (problem_hash),
        INDEX idx_ip_coding_due (category, due_at)
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_coding_attempt (
        id INT AUTO_INCREMENT PRIMARY KEY,
        problem_id INT NOT NULL,
        wpm INT NOT NULL DEFAULT 0,
        accuracy INT NOT NULL DEFAULT 0,
        duration_sec INT NOT NULL DEFAULT 0,
        keystrokes INT NOT NULL DEFAULT 0,
        errors INT NOT NULL DEFAULT 0,
        mode VARCHAR(16) NOT NULL DEFAULT 'ghost',
        grade VARCHAR(10) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip_coding_attempt (problem_id, created_at),
        CONSTRAINT fk_ip_coding_attempt_problem FOREIGN KEY (problem_id)
          REFERENCES ip_coding_problem(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_coding_trace (
        id INT AUTO_INCREMENT PRIMARY KEY,
        problem_id INT NOT NULL,
        solution_hash CHAR(64) NOT NULL,
        trace_json MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_ip_coding_trace (problem_id),
        CONSTRAINT fk_ip_coding_trace_problem FOREIGN KEY (problem_id)
          REFERENCES ip_coding_problem(id) ON DELETE CASCADE
      )
    `);
    // 面试模式:一场「AI 出题 → 自由手写 → 边写边追问 → 复盘」的记录。
    // 题目本身仍落在 ip_coding_problem(所以事后还能拿去跟打),这张表只存这一场的过程。
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_mock_interview (
        id INT AUTO_INCREMENT PRIMARY KEY,
        problem_id INT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        lang VARCHAR(16) NOT NULL DEFAULT 'java',
        code MEDIUMTEXT NOT NULL,
        turns_json MEDIUMTEXT NULL,
        review_json MEDIUMTEXT NULL,
        verdict VARCHAR(10) NULL,
        duration_sec INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip_mock_created (created_at),
        CONSTRAINT fk_ip_mock_problem FOREIGN KEY (problem_id)
          REFERENCES ip_coding_problem(id) ON DELETE SET NULL
      )
    `);
    // 后加的列(老库升级用;新库上面已建好,重复执行报 ER_DUP_FIELDNAME 直接忽略)。
    await execIgnoring("ALTER TABLE ip_coding_problem ADD COLUMN setup MEDIUMTEXT NULL", ["ER_DUP_FIELDNAME"]);
    // 英文题干:面试是英文的,题面也要能读英文(老库里的题先留空,再导入种子题时补齐)。
    await execIgnoring("ALTER TABLE ip_coding_problem ADD COLUMN prompt_en MEDIUMTEXT NULL", ["ER_DUP_FIELDNAME"]);
  })().catch((err) => {
    codingSchemaReady = null; // 失败不缓存,下次重试
    throw err;
  });
  return codingSchemaReady;
}

/* ---------------- 题目 ---------------- */

export type CodingProblemRow = {
  id: number;
  category: string;
  lang: string;
  title: string;
  prompt: string;
  prompt_en: string | null;
  setup: string | null;
  solution: string;
  explanation: string | null;
  difficulty: number;
  source: string;
  runs: number;
  best_wpm: number;
  best_accuracy: number;
  last_wpm: number;
  last_accuracy: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  fsrs_difficulty: number | null;
  fsrs_stability: number | null;
  fsrs_state: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_grade: string | null;
  created_at: string;
  is_due: number;
  elapsed_sec?: number | null;
};

export type CodingProblemInput = {
  category: CodingCategory;
  lang: CodingLang;
  title: string;
  prompt: string;
  promptEn?: string;
  setup?: string;
  solution: string;
  explanation?: string;
  difficulty: number;
  source: "seed" | "ai";
};

const PROBLEM_COLS = `id, category, lang, title, prompt, prompt_en, setup, solution, explanation, difficulty, source,
  runs, best_wpm, best_accuracy, last_wpm, last_accuracy,
  interval_days, repetitions, lapses, fsrs_difficulty, fsrs_stability, fsrs_state,
  due_at, last_reviewed_at, last_grade, created_at`;

const numify = (r: CodingProblemRow): CodingProblemRow => ({
  ...r,
  difficulty: Number(r.difficulty),
  runs: Number(r.runs),
  best_wpm: Number(r.best_wpm),
  best_accuracy: Number(r.best_accuracy),
  last_wpm: Number(r.last_wpm),
  last_accuracy: Number(r.last_accuracy),
  interval_days: Number(r.interval_days),
  repetitions: Number(r.repetitions),
  lapses: Number(r.lapses),
  fsrs_difficulty: r.fsrs_difficulty == null ? null : Number(r.fsrs_difficulty),
  fsrs_stability: r.fsrs_stability == null ? null : Number(r.fsrs_stability),
  fsrs_state: Number(r.fsrs_state),
  is_due: Number(r.is_due),
  elapsed_sec: r.elapsed_sec == null ? null : Number(r.elapsed_sec),
});

/**
 * 批量入库(种子题 / AI 出的题都走这里)。
 * INSERT IGNORE + problem_hash 唯一键 = 同一道题重复导入自动跳过,返回真正新增的条数。
 */
export async function addCodingProblems(items: CodingProblemInput[]): Promise<number> {
  if (!items.length) return 0;
  await ensureCodingSchema();
  const p = getPool();
  const CHUNK = 50;
  let added = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())").join(", ");
    const params: unknown[] = [];
    for (const it of chunk) {
      params.push(
        it.category,
        it.lang,
        it.title.slice(0, 255),
        it.prompt.slice(0, 4000),
        (it.promptEn ?? "").slice(0, 4000) || null,
        (it.setup ?? "").slice(0, 4000) || null,
        it.solution.slice(0, 8000),
        (it.explanation ?? "").slice(0, 4000) || null,
        Math.max(1, Math.min(3, Math.round(it.difficulty) || 2)),
        it.source,
        problemHash(it.category, it.title),
      );
    }
    const [res] = await p.query<ResultSetHeader>(
      `INSERT IGNORE INTO ip_coding_problem
         (category, lang, title, prompt, prompt_en, setup, solution, explanation, difficulty, source, problem_hash, due_at)
       VALUES ${placeholders}`,
      params,
    );
    added += res.affectedRows || 0;
  }
  return added;
}

/**
 * 给「已经在库、但还没有英文题干」的题补上英文(种子题加了 promptEn 之后,老库里的题也能补齐)。
 * 只填空的,不覆盖已有内容,更不碰用户改过的题干和练习进度。返回补齐的条数。
 */
export async function fillMissingEnglish(items: CodingProblemInput[]): Promise<number> {
  const withEn = items.filter((it) => (it.promptEn ?? "").trim());
  if (!withEn.length) return 0;
  await ensureCodingSchema();
  const p = getPool();
  const CHUNK = 50;
  let filled = 0;
  for (let i = 0; i < withEn.length; i += CHUNK) {
    const chunk = withEn.slice(i, i + CHUNK);
    const cases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const params: unknown[] = [];
    for (const it of chunk) {
      params.push(problemHash(it.category, it.title), (it.promptEn ?? "").slice(0, 4000));
    }
    for (const it of chunk) params.push(problemHash(it.category, it.title));
    const [res] = await p.query<ResultSetHeader>(
      `UPDATE ip_coding_problem
          SET prompt_en = CASE problem_hash ${cases} END
        WHERE problem_hash IN (${chunk.map(() => "?").join(", ")})
          AND (prompt_en IS NULL OR prompt_en = '')`,
      params,
    );
    filled += res.affectedRows || 0;
  }
  return filled;
}

/* ---------------- 断点拆解(每步返回什么) ---------------- */

/** 参考代码的哈希:改了代码,缓存的拆解就自动失效(不会再拿旧的类型糊弄你)。 */
export function solutionHash(solution: string): string {
  return createHash("sha256").update(solution).digest("hex");
}

/** 取这道题缓存的拆解;参考代码变了(哈希对不上)当作没有。 */
export async function getCodingTrace(problemId: number, solution: string): Promise<unknown | null> {
  await ensureCodingSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT trace_json, solution_hash FROM ip_coding_trace WHERE problem_id = ? LIMIT 1",
    [problemId],
  );
  const row = rows[0] as { trace_json: string; solution_hash: string } | undefined;
  if (!row || row.solution_hash !== solutionHash(solution)) return null;
  try {
    return JSON.parse(row.trace_json);
  } catch {
    return null;
  }
}

export async function saveCodingTrace(problemId: number, solution: string, trace: unknown): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  await p.execute(
    `INSERT INTO ip_coding_trace (problem_id, solution_hash, trace_json) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE solution_hash = VALUES(solution_hash), trace_json = VALUES(trace_json),
                             created_at = NOW()`,
    [problemId, solutionHash(solution), JSON.stringify(trace).slice(0, 60000)],
  );
}

/** 已入库的题目标题(给 AI 出题「别再出重复的」用) */
export async function listCodingTitles(category?: CodingCategory): Promise<string[]> {
  await ensureCodingSchema();
  const p = getPool();
  const [rows] = category
    ? await p.execute<RowDataPacket[]>(
        "SELECT title FROM ip_coding_problem WHERE category = ? ORDER BY id DESC LIMIT 200",
        [category],
      )
    : await p.query<RowDataPacket[]>("SELECT title FROM ip_coding_problem ORDER BY id DESC LIMIT 200");
  return (rows as Array<{ title: string }>).map((r) => r.title);
}

/**
 * 题目列表(可按分类筛)。排序与猛攻版一致:到期的排前面,
 * 到期的老题里「记忆最脆弱的」(FSRS 稳定性最小)先来,再按到期时间。
 */
export async function listCodingProblems(category?: CodingCategory): Promise<CodingProblemRow[]> {
  await ensureCodingSchema();
  const p = getPool();
  const where = category ? "WHERE category = ?" : "";
  const params = category ? [category] : [];
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT ${PROBLEM_COLS},
            (last_reviewed_at IS NULL OR due_at IS NULL OR due_at <= NOW()) AS is_due
       FROM ip_coding_problem
       ${where}
      ORDER BY (last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= NOW()) DESC,
               CASE WHEN last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= NOW()
                    THEN COALESCE(fsrs_stability, interval_days, 0) END ASC,
               due_at ASC, id ASC`,
    params,
  );
  return (rows as CodingProblemRow[]).map(numify);
}

export async function getCodingProblem(id: number): Promise<CodingProblemRow | null> {
  await ensureCodingSchema();
  const p = getPool();
  // elapsed_sec:距上次复习的秒数(库内算差,避开时区),供 FSRS 计算 elapsed_days。
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT ${PROBLEM_COLS},
            (last_reviewed_at IS NULL OR due_at IS NULL OR due_at <= NOW()) AS is_due,
            TIMESTAMPDIFF(SECOND, last_reviewed_at, NOW()) AS elapsed_sec
       FROM ip_coding_problem WHERE id = ?`,
    [id],
  );
  const r = rows[0] as CodingProblemRow | undefined;
  return r ? numify(r) : null;
}

/** 手改题目(参考代码有错时就地改)。只更新传了的字段,不动进度。 */
export async function updateCodingProblem(
  id: number,
  patch: { title?: string; prompt?: string; promptEn?: string; setup?: string; solution?: string; explanation?: string },
): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title.slice(0, 255));
  }
  if (patch.prompt !== undefined) {
    sets.push("prompt = ?");
    params.push(patch.prompt.slice(0, 4000));
  }
  if (patch.promptEn !== undefined) {
    sets.push("prompt_en = ?");
    params.push(patch.promptEn.slice(0, 4000) || null);
  }
  if (patch.setup !== undefined) {
    sets.push("setup = ?");
    params.push(patch.setup.slice(0, 4000) || null);
  }
  if (patch.solution !== undefined) {
    sets.push("solution = ?");
    params.push(patch.solution.slice(0, 8000));
  }
  if (patch.explanation !== undefined) {
    sets.push("explanation = ?");
    params.push(patch.explanation.slice(0, 4000) || null);
  }
  if (!sets.length) return;
  params.push(id);
  await p.execute(`UPDATE ip_coding_problem SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function deleteCodingProblem(id: number): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  await p.execute("DELETE FROM ip_coding_problem WHERE id = ?", [id]);
}

/* ---------------- 复习调度 + 成绩 ---------------- */

/** 敲完一遍后按 FSRS 更新调度(与猛攻版同口径:due_at 用整天间隔落库,避开时区)。 */
export async function updateCodingFsrs(
  id: number,
  update: { difficulty: number; stability: number; state: number; reps: number; lapses: number; intervalDays: number },
  grade: string,
): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  await p.execute(
    `UPDATE ip_coding_problem
        SET fsrs_difficulty = ?, fsrs_stability = ?, fsrs_state = ?,
            repetitions = ?, lapses = ?, interval_days = ?,
            last_grade = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?`,
    [
      update.difficulty,
      update.stability,
      update.state,
      update.reps,
      update.lapses,
      update.intervalDays,
      grade,
      update.intervalDays,
      id,
    ],
  );
}

export type CodingAttemptInput = {
  problemId: number;
  wpm: number;
  accuracy: number;
  durationSec: number;
  keystrokes: number;
  errors: number;
  mode: string;
  grade: string;
};

/** 记一次成绩:写 attempt 明细,并把题目上的「最好/最近」成绩刷新。 */
export async function recordCodingAttempt(a: CodingAttemptInput): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  await p.execute(
    `INSERT INTO ip_coding_attempt (problem_id, wpm, accuracy, duration_sec, keystrokes, errors, mode, grade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.problemId, a.wpm, a.accuracy, a.durationSec, a.keystrokes, a.errors, a.mode.slice(0, 16), a.grade.slice(0, 10)],
  );
  await p.execute(
    `UPDATE ip_coding_problem
        SET runs = runs + 1,
            last_wpm = ?, last_accuracy = ?,
            best_wpm = GREATEST(best_wpm, ?), best_accuracy = GREATEST(best_accuracy, ?)
      WHERE id = ?`,
    [a.wpm, a.accuracy, a.wpm, a.accuracy, a.problemId],
  );
}

export type CodingAttemptRow = {
  id: number;
  wpm: number;
  accuracy: number;
  duration_sec: number;
  errors: number;
  mode: string;
  grade: string | null;
  created_at: string;
};

export async function listCodingAttempts(problemId: number, limit = 10): Promise<CodingAttemptRow[]> {
  await ensureCodingSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, wpm, accuracy, duration_sec, errors, mode, grade, created_at
       FROM ip_coding_attempt WHERE problem_id = ? ORDER BY id DESC LIMIT ?`,
    [problemId, Math.max(1, Math.min(50, limit))],
  );
  return (rows as CodingAttemptRow[]).map((r) => ({
    ...r,
    wpm: Number(r.wpm),
    accuracy: Number(r.accuracy),
    duration_sec: Number(r.duration_sec),
    errors: Number(r.errors),
  }));
}

/* ---------------- 给前端的视图对象 ---------------- */

export type CodingProblemView = {
  id: number;
  category: string;
  lang: string;
  title: string;
  prompt: string;
  promptEn: string;
  setup: string;
  solution: string;
  explanation: string;
  difficulty: number;
  source: string;
  runs: number;
  bestWpm: number;
  bestAccuracy: number;
  lastWpm: number;
  lastAccuracy: number;
  state: SrState;
  isDue: boolean;
  dueAt: string | null;
  intervalDays: number;
};

/** 库里的行 → 前端用的题目对象(记忆状态按 FSRS 稳定性折算) */
export function toCodingView(r: CodingProblemRow): CodingProblemView {
  return {
    id: r.id,
    category: r.category,
    lang: r.lang,
    title: r.title,
    prompt: r.prompt,
    promptEn: r.prompt_en ?? "",
    setup: r.setup ?? "",
    solution: r.solution,
    explanation: r.explanation ?? "",
    difficulty: r.difficulty,
    source: r.source,
    runs: r.runs,
    bestWpm: r.best_wpm,
    bestAccuracy: r.best_accuracy,
    lastWpm: r.last_wpm,
    lastAccuracy: r.last_accuracy,
    state: srStateFromStability(!!r.last_reviewed_at, r.fsrs_stability ?? 0),
    isDue: r.is_due === 1,
    dueAt: r.due_at,
    intervalDays: r.interval_days,
  };
}

export type CodingCounts = { category: string; total: number; due: number }[];

/** 各分类的题量 / 今日待练量(筛选条上的角标) */
export async function codingCounts(): Promise<CodingCounts> {
  await ensureCodingSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT category,
            COUNT(*) AS total,
            SUM(last_reviewed_at IS NULL OR due_at IS NULL OR due_at <= NOW()) AS due
       FROM ip_coding_problem GROUP BY category`,
  );
  return (rows as Array<{ category: string; total: unknown; due: unknown }>).map((r) => ({
    category: r.category,
    total: Number(r.total) || 0,
    due: Number(r.due) || 0,
  }));
}

/* ---------------- 面试模式 ---------------- */

/**
 * 面试模式现出的题:入库并把 id 拿回来(`addCodingProblems` 只回条数,这里要拿 id 关联这场面试)。
 * 仍走 INSERT IGNORE + problem_hash 唯一键 —— 万一撞上已有的同名题,就复用那一条,不再插一份。
 */
export async function addCodingProblemGetId(it: CodingProblemInput): Promise<{ id: number; created: boolean }> {
  await ensureCodingSchema();
  const p = getPool();
  const hash = problemHash(it.category, it.title);
  const [res] = await p.execute<ResultSetHeader>(
    `INSERT IGNORE INTO ip_coding_problem
       (category, lang, title, prompt, prompt_en, setup, solution, explanation, difficulty, source, problem_hash, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      it.category,
      it.lang,
      it.title.slice(0, 255),
      it.prompt.slice(0, 4000),
      (it.promptEn ?? "").slice(0, 4000) || null,
      (it.setup ?? "").slice(0, 4000) || null,
      it.solution.slice(0, 8000),
      (it.explanation ?? "").slice(0, 4000) || null,
      Math.max(1, Math.min(3, Math.round(it.difficulty) || 2)),
      it.source,
      hash,
    ],
  );
  if (res.insertId) return { id: res.insertId, created: (res.affectedRows || 0) > 0 };
  // 撞了唯一键:把已有那条的 id 查回来。
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id FROM ip_coding_problem WHERE problem_hash = ? LIMIT 1",
    [hash],
  );
  const id = (rows[0] as { id?: number } | undefined)?.id;
  if (!id) throw new Error("题目入库失败");
  return { id, created: false };
}

export type MockInterviewRow = {
  id: number;
  problem_id: number | null;
  title: string;
  lang: string;
  code: string;
  turns_json: string | null;
  review_json: string | null;
  verdict: string | null;
  duration_sec: number;
  created_at: string;
};

const MOCK_COLS = "id, problem_id, title, lang, code, turns_json, review_json, verdict, duration_sec, created_at";

export async function saveMockInterview(v: {
  problemId: number | null;
  title: string;
  lang: string;
  code: string;
  turnsJson: string;
  reviewJson: string;
  verdict: string;
  durationSec: number;
}): Promise<number> {
  await ensureCodingSchema();
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    `INSERT INTO ip_mock_interview (problem_id, title, lang, code, turns_json, review_json, verdict, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.problemId,
      v.title.slice(0, 255),
      v.lang.slice(0, 16),
      v.code.slice(0, 60_000),
      v.turnsJson.slice(0, 200_000) || null,
      v.reviewJson.slice(0, 200_000) || null,
      v.verdict.slice(0, 10) || null,
      Math.max(0, Math.round(v.durationSec) || 0),
    ],
  );
  return res.insertId;
}

/** 最近几场面试(列表用,不带代码正文以外的大字段裁剪 —— 量很小,直接全取)。 */
export async function listMockInterviews(limit = 20): Promise<MockInterviewRow[]> {
  await ensureCodingSchema();
  const p = getPool();
  const n = Math.max(1, Math.min(50, Math.round(limit) || 20));
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT ${MOCK_COLS} FROM ip_mock_interview ORDER BY created_at DESC, id DESC LIMIT ${n}`,
  );
  return (rows as MockInterviewRow[]).map((r) => ({ ...r, duration_sec: Number(r.duration_sec) }));
}

export async function deleteMockInterview(id: number): Promise<void> {
  await ensureCodingSchema();
  const p = getPool();
  await p.execute("DELETE FROM ip_mock_interview WHERE id = ?", [id]);
}
