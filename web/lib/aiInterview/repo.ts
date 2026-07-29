import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

import {
  asLang,
  asMode,
  asRole,
  clip,
  LIMITS,
  type Lang,
  type Mode,
  type SessionDetail,
  type SessionMeta,
  type Turn,
} from "./schema";

/**
 * 「AI 辅助面试」的持久化层:一场面试 = 一条 ai_itv_session + 若干 ai_itv_turn。
 * 复用同一个 MySQL 池(getPool),表前缀 ai_itv_,幂等建表。
 *
 * **不存简历原文**:复盘只需要 JD + 对话记录,简历是 PII 且本来就在别处(默认简历/上传),
 * 没必要在每场面试里再抄一份进库。
 */

/** 一场面试最多存多少句(超长会话只保留最近的,避免单会话把库撑爆) */
const MAX_TURNS = 2_000;
/** 一次 INSERT 拼多少行 */
const INSERT_CHUNK = 200;

let schemaReady: Promise<void> | null = null;

export function ensureAiInterviewSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS ai_itv_session (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL DEFAULT '',
        mode VARCHAR(24) NOT NULL DEFAULT 'tech',
        lang VARCHAR(8) NOT NULL DEFAULT 'en',
        company VARCHAR(120) NOT NULL DEFAULT '',
        jd_text MEDIUMTEXT NOT NULL,
        notes_text MEDIUMTEXT NOT NULL,
        summary MEDIUMTEXT NOT NULL,
        turn_count INT NOT NULL DEFAULT 0,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME NULL
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ai_itv_turn (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        role VARCHAR(16) NOT NULL,
        at_ms INT NOT NULL DEFAULT 0,
        text MEDIUMTEXT NOT NULL,
        INDEX idx_ai_itv_turn_session (session_id, at_ms, id),
        CONSTRAINT fk_ai_itv_turn_session FOREIGN KEY (session_id)
          REFERENCES ai_itv_session(id) ON DELETE CASCADE
      )
    `);
  })().catch((err) => {
    schemaReady = null; // 失败不缓存,下次重试
    throw err;
  });
  return schemaReady;
}

/* ============================ 写 ============================ */

export async function createSession(input: {
  title: string;
  mode: Mode;
  lang: Lang;
  company: string;
  jd: string;
  notes: string;
}): Promise<number> {
  await ensureAiInterviewSchema();
  const [res] = await getPool().query<ResultSetHeader>(
    `INSERT INTO ai_itv_session (title, mode, lang, company, jd_text, notes_text, summary)
     VALUES (?, ?, ?, ?, ?, ?, '')`,
    [
      clip(input.title, LIMITS.title),
      input.mode,
      input.lang,
      clip(input.company, LIMITS.company),
      clip(input.jd, LIMITS.jd),
      clip(input.notes, LIMITS.notes),
    ],
  );
  return res.insertId;
}

/**
 * 用整份字幕覆盖这场面试的记录(全量覆盖而不是追加)。
 * 前端会把「被切开的同一句」合并成一句,已经发过的句子后面还可能被改长;
 * 全量覆盖天然幂等,不用在两边维护「哪句发过」的游标。
 */
export async function replaceTurns(sessionId: number, turns: Turn[]): Promise<number> {
  await ensureAiInterviewSchema();
  const p = getPool();
  const kept = turns.slice(-MAX_TURNS);

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM ai_itv_turn WHERE session_id = ?", [sessionId]);
    for (let i = 0; i < kept.length; i += INSERT_CHUNK) {
      const chunk = kept.slice(i, i + INSERT_CHUNK);
      const values = chunk.flatMap((t) => [sessionId, t.role, t.at, t.text]);
      const holes = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      await conn.query(
        `INSERT INTO ai_itv_turn (session_id, role, at_ms, text) VALUES ${holes}`,
        values,
      );
    }
    await conn.query("UPDATE ai_itv_session SET turn_count = ? WHERE id = ?", [
      kept.length,
      sessionId,
    ]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return kept.length;
}

export async function setSummary(sessionId: number, summary: string): Promise<void> {
  await ensureAiInterviewSchema();
  await getPool().query("UPDATE ai_itv_session SET summary = ? WHERE id = ?", [summary, sessionId]);
}

export async function renameSession(sessionId: number, title: string): Promise<void> {
  await ensureAiInterviewSchema();
  await getPool().query("UPDATE ai_itv_session SET title = ? WHERE id = ?", [
    clip(title, LIMITS.title),
    sessionId,
  ]);
}

export async function endSession(sessionId: number): Promise<void> {
  await ensureAiInterviewSchema();
  await getPool().query(
    "UPDATE ai_itv_session SET ended_at = COALESCE(ended_at, NOW()) WHERE id = ?",
    [sessionId],
  );
}

export async function deleteSession(sessionId: number): Promise<void> {
  await ensureAiInterviewSchema();
  await getPool().query("DELETE FROM ai_itv_session WHERE id = ?", [sessionId]);
}

/* ============================ 读 ============================ */

type SessionRow = RowDataPacket & {
  id: number;
  title: string;
  mode: string;
  lang: string;
  company: string;
  jd_text: string;
  notes_text: string;
  summary: string;
  turn_count: number;
  started_at: string;
  ended_at: string | null;
};

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    mode: asMode(row.mode),
    lang: asLang(row.lang),
    company: row.company,
    turnCount: row.turn_count,
    hasSummary: !!row.summary?.trim(),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export async function listSessions(limit = 30): Promise<SessionMeta[]> {
  await ensureAiInterviewSchema();
  const [rows] = await getPool().query<SessionRow[]>(
    `SELECT id, title, mode, lang, company, '' AS jd_text, '' AS notes_text,
            IF(summary = '', '', 'y') AS summary, turn_count, started_at, ended_at
       FROM ai_itv_session
      ORDER BY id DESC
      LIMIT ?`,
    [Math.max(1, Math.min(200, limit))],
  );
  return rows.map(toMeta);
}

export async function getSession(sessionId: number): Promise<SessionDetail | null> {
  await ensureAiInterviewSchema();
  const p = getPool();
  const [rows] = await p.query<SessionRow[]>(
    `SELECT id, title, mode, lang, company, jd_text, notes_text, summary, turn_count, started_at, ended_at
       FROM ai_itv_session WHERE id = ? LIMIT 1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;

  const [turnRows] = await p.query<(RowDataPacket & { role: string; at_ms: number; text: string })[]>(
    `SELECT role, at_ms, text FROM ai_itv_turn WHERE session_id = ? ORDER BY at_ms ASC, id ASC`,
    [sessionId],
  );
  const turns: Turn[] = turnRows.map((t) => ({
    role: asRole(t.role),
    at: t.at_ms,
    text: t.text,
  }));

  return {
    ...toMeta(row),
    hasSummary: !!row.summary?.trim(),
    jd: row.jd_text,
    notes: row.notes_text,
    summary: row.summary,
    turns,
  };
}
