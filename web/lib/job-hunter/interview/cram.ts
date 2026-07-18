import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

/**
 * 「对应简历猛攻版」的持久化层。与面试题库(repo.ts)相互独立:
 * - ip_cram_session:一份上传的简历/面试稿(存 HTML,按归一化文本 SHA-256 去重)。
 * - ip_cram_card:这份简历下的复习卡(word 单词卡 / block 知识块 / svg 记忆图卡),
 *   带 SM-2 遗忘曲线列(与 ip_knowledge 同口径),按 session 归属。
 * 复用同一个 Aiven 连接池(getPool),表加 ip_cram_ 前缀,建在同一 defaultdb。
 */

let cramSchemaReady: Promise<void> | null = null;

export function ensureCramSchema(): Promise<void> {
  if (cramSchemaReady) return cramSchemaReady;
  cramSchemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_cram_session (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL DEFAULT '',
        language VARCHAR(50) NOT NULL DEFAULT 'English',
        resume_hash CHAR(64) NULL,
        resume_html MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_cram_resume_hash (resume_hash)
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_cram_card (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        kind VARCHAR(16) NOT NULL DEFAULT 'block',
        front MEDIUMTEXT NULL,
        content MEDIUMTEXT NOT NULL,
        svg MEDIUMTEXT NULL,
        extra_json MEDIUMTEXT NULL,
        ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50,
        interval_days INT NOT NULL DEFAULT 0,
        repetitions INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        last_reviewed_at DATETIME NULL,
        last_grade VARCHAR(10) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip_cram_card_due (session_id, due_at),
        CONSTRAINT fk_ip_cram_card_session FOREIGN KEY (session_id)
          REFERENCES ip_cram_session(id) ON DELETE CASCADE
      )
    `);
  })().catch((err) => {
    cramSchemaReady = null; // 失败不缓存,下次重试
    throw err;
  });
  return cramSchemaReady;
}

/* ---------------- session(一份简历) ---------------- */

export type CramSessionRow = {
  id: number;
  title: string;
  language: string;
  resume_hash: string | null;
  resume_html: string;
  created_at: string;
};

export type CramSessionSummary = {
  id: number;
  title: string;
  language: string;
  created_at: string;
  total: number;
  due: number;
};

const MAX_HTML = 4_000_000; // MEDIUMTEXT 上限约 16MB,给足富样式简历,再留裕量

export async function createCramSession(args: {
  title: string;
  language: string;
  resumeHash: string;
  resumeHtml: string;
}): Promise<number> {
  await ensureCramSchema();
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_cram_session (title, language, resume_hash, resume_html) VALUES (?, ?, ?, ?)",
    [args.title.slice(0, 255), args.language.slice(0, 50), args.resumeHash.slice(0, 64), args.resumeHtml.slice(0, MAX_HTML)],
  );
  return res.insertId;
}

export async function findCramSessionByHash(resumeHash: string): Promise<CramSessionRow | null> {
  await ensureCramSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, title, language, resume_hash, resume_html, created_at FROM ip_cram_session WHERE resume_hash = ? LIMIT 1",
    [resumeHash],
  );
  return (rows[0] as CramSessionRow | undefined) ?? null;
}

export async function getCramSession(id: number): Promise<CramSessionRow | null> {
  await ensureCramSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, title, language, resume_hash, resume_html, created_at FROM ip_cram_session WHERE id = ? LIMIT 1",
    [id],
  );
  return (rows[0] as CramSessionRow | undefined) ?? null;
}

export async function listCramSessions(): Promise<CramSessionSummary[]> {
  await ensureCramSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT s.id, s.title, s.language, s.created_at,
            COUNT(c.id) AS total,
            SUM(c.id IS NOT NULL AND (c.last_reviewed_at IS NULL OR c.due_at IS NULL OR c.due_at <= NOW())) AS due
       FROM ip_cram_session s
       LEFT JOIN ip_cram_card c ON c.session_id = s.id
      GROUP BY s.id, s.title, s.language, s.created_at
      ORDER BY s.created_at DESC, s.id DESC`,
  );
  return (rows as Array<CramSessionSummary & { total: unknown; due: unknown }>).map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    created_at: r.created_at,
    total: Number(r.total) || 0,
    due: Number(r.due) || 0,
  }));
}

export async function deleteCramSession(id: number): Promise<void> {
  await ensureCramSchema();
  const p = getPool();
  await p.execute("DELETE FROM ip_cram_session WHERE id = ?", [id]);
}

/* ---------------- card(复习卡:单词 / 知识块 / SVG 记忆图卡) ---------------- */

export type CramCardKind = "word" | "block" | "svg";

export type CramCardRow = {
  id: number;
  session_id: number;
  kind: string;
  front: string | null;
  content: string;
  svg: string | null;
  extra_json: string | null;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_grade: string | null;
  is_due: number;
};

const numify = (r: CramCardRow): CramCardRow => ({
  ...r,
  ease_factor: Number(r.ease_factor),
  interval_days: Number(r.interval_days),
  repetitions: Number(r.repetitions),
  lapses: Number(r.lapses),
  is_due: Number(r.is_due),
});

export async function addCramCard(v: {
  sessionId: number;
  kind: CramCardKind;
  front: string;
  content: string;
  svg?: string;
  extra?: unknown;
}): Promise<number> {
  await ensureCramSchema();
  const p = getPool();
  const extra = v.extra != null ? JSON.stringify(v.extra).slice(0, 4000) : null;
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_cram_card (session_id, kind, front, content, svg, extra_json, due_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
    [
      v.sessionId,
      v.kind,
      v.front.slice(0, 2000) || null,
      v.content.slice(0, 8000),
      (v.svg ?? "").slice(0, 20000) || null,
      extra,
    ],
  );
  return res.insertId;
}

const CARD_COLS =
  `id, session_id, kind, front, content, svg, extra_json, ease_factor, interval_days, repetitions, lapses,
   due_at, last_reviewed_at, last_grade`;

export async function listCramCards(sessionId: number): Promise<CramCardRow[]> {
  await ensureCramSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT ${CARD_COLS},
            (last_reviewed_at IS NULL OR due_at IS NULL OR due_at <= NOW()) AS is_due
       FROM ip_cram_card
      WHERE session_id = ?
      ORDER BY (last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= NOW()) DESC,
               due_at ASC, id DESC`,
    [sessionId],
  );
  return (rows as CramCardRow[]).map(numify);
}

export async function getCramCard(id: number): Promise<CramCardRow | null> {
  await ensureCramSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT ${CARD_COLS}, 1 AS is_due FROM ip_cram_card WHERE id = ?`,
    [id],
  );
  const r = rows[0] as CramCardRow | undefined;
  return r ? numify(r) : null;
}

/** 复习后按 SM-2 更新记忆卡调度(与 updateKnowledgeSr 同口径)。 */
export async function updateCramCardSr(
  id: number,
  update: { ease_factor: number; interval_days: number; repetitions: number; lapses: number },
  grade: string,
): Promise<void> {
  await ensureCramSchema();
  const p = getPool();
  await p.execute(
    `UPDATE ip_cram_card
        SET ease_factor = ?, interval_days = ?, repetitions = ?, lapses = ?,
            last_grade = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?`,
    [update.ease_factor, update.interval_days, update.repetitions, update.lapses, grade, update.interval_days, id],
  );
}

export async function deleteCramCard(id: number): Promise<void> {
  await ensureCramSchema();
  const p = getPool();
  await p.execute("DELETE FROM ip_cram_card WHERE id = ?", [id]);
}
