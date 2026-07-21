import type { RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";

/**
 * 小红书「已评论/已互动笔记」去重库。复用收费计算器的 MySQL 连接池（同一组 DB_* 变量）。
 * 去重键 = note_id（忽略会变化的 xsec_token）：同一篇笔记以后再出现在搜索/信息流/链接里，
 * 都能认出来，避免重复评论。仅在「评论真实发布成功」时记录。
 * 与「已发布笔记」库(xhs_published_notes) 相互独立，互不影响。
 */

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。多次调用只执行一次。 */
export function ensureCommentedSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS xhs_commented_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        note_id VARCHAR(64) NOT NULL UNIQUE,
        url TEXT NULL,
        title VARCHAR(255) NULL,
        comment TEXT NULL,
        liked_comment TINYINT(1) NOT NULL DEFAULT 0,
        liked_note TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  })().catch((err) => {
    // 失败不缓存，下次重试建表
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// —— 「每天自动评论」的 24 小时滚动闸门 ——
// 只需记住「上次成功评论的时间点」。用一张固定单行表（主键 job），每次成功 UPSERT 覆盖，
// 天然只保留最新一条、不累积存储；读回时和 24h 比较决定这次要不要真的发。

/** 自动任务的固定主键：保证该表永远只有这一行。 */
export const AUTO_RUN_JOB = "homefeed-auto";

let autoSchemaReady: Promise<void> | null = null;

/** 首次使用时建「自动运行记录」表(幂等)。 */
export function ensureAutoRunSchema(): Promise<void> {
  if (autoSchemaReady) return autoSchemaReady;
  autoSchemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS xhs_engage_auto_run (
        job VARCHAR(64) NOT NULL PRIMARY KEY,
        last_success_at DATETIME NOT NULL,
        posted_count INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  })().catch((err) => {
    autoSchemaReady = null;
    throw err;
  });
  return autoSchemaReady;
}

/**
 * 读上次成功运行的时间，返回 Unix 毫秒时间戳；从未成功跑过返回 null。
 * 用 UNIX_TIMESTAMP() 让 DB 直接给出 UTC 纪元秒，避免 DATETIME 字符串 + 时区解析的坑。
 */
export async function getLastAutoRunAt(job = AUTO_RUN_JOB): Promise<number | null> {
  await ensureAutoRunSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT UNIX_TIMESTAMP(last_success_at) AS ts FROM xhs_engage_auto_run WHERE job = ?`,
    [job],
  );
  const ts = (rows[0] as { ts?: number | string } | undefined)?.ts;
  if (ts == null) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? n * 1000 : null;
}

/**
 * 记录一次成功运行（UPSERT 覆盖同一行：把上次的时间点直接改成现在，等于「删掉旧的、只留最新」）。
 * postedCount 仅作参考，不影响闸门逻辑。
 */
export async function recordAutoRun(postedCount = 0, job = AUTO_RUN_JOB): Promise<void> {
  await ensureAutoRunSchema();
  const p = getPool();
  await p.query(
    `INSERT INTO xhs_engage_auto_run (job, last_success_at, posted_count)
     VALUES (?, NOW(), ?)
     ON DUPLICATE KEY UPDATE last_success_at = NOW(), posted_count = VALUES(posted_count)`,
    [job, Math.max(0, Math.floor(postedCount))],
  );
}

/** 查询给定 note_id 中哪些已评论过，返回已评论的集合。 */
export async function getCommentedNoteIds(noteIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(noteIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  await ensureCommentedSchema();
  const p = getPool();
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT note_id FROM xhs_commented_notes WHERE note_id IN (${placeholders})`,
    ids,
  );
  const done = new Set<string>();
  for (const r of rows) done.add(String((r as { note_id: string }).note_id));
  return done;
}

/** 记录一篇已成功评论的笔记（幂等：同 note_id 覆盖最新链接/标题/评论/点赞状态）。 */
export async function markCommented(opts: {
  noteId: string;
  url?: string;
  title?: string;
  comment?: string;
  likedComment?: boolean;
  likedNote?: boolean;
}): Promise<void> {
  if (!opts.noteId) return;
  await ensureCommentedSchema();
  const p = getPool();
  await p.query(
    `INSERT INTO xhs_commented_notes (note_id, url, title, comment, liked_comment, liked_note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       url = VALUES(url),
       title = VALUES(title),
       comment = VALUES(comment),
       liked_comment = VALUES(liked_comment),
       liked_note = VALUES(liked_note)`,
    [
      opts.noteId,
      opts.url ?? null,
      (opts.title ?? "").slice(0, 255) || null,
      (opts.comment ?? "").slice(0, 2000) || null,
      opts.likedComment ? 1 : 0,
      opts.likedNote ? 1 : 0,
    ],
  );
}
