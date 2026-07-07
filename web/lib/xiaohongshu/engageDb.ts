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
