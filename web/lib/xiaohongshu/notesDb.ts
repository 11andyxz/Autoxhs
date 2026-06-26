import type { RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import { parseNoteId } from "@/lib/xiaohongshu/url";

// 兼容既有从本模块导入 parseNoteId 的调用方（publish / check 路由）。
export { parseNoteId };

/**
 * 小红书「已发布笔记」去重库。复用收费计算器的 MySQL 连接池（同一组 DB_* 变量）。
 * 去重键 = 链接里的 note_id（路径最后一段），忽略会变化的 xsec_token：同一篇笔记用不同 token
 * 复制进来也算同一篇。仅在「真实公开发布成功」时记录；批量粘贴时据此跳过之前发过的。
 */

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。多次调用只执行一次。 */
export function ensureXhsSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS xhs_published_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        note_id VARCHAR(64) NOT NULL UNIQUE,
        source_url TEXT NULL,
        title VARCHAR(255) NULL,
        share_link TEXT NULL,
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

/** 查询给定 note_id 中哪些已发布过，返回已发布的集合。 */
export async function getDoneNoteIds(noteIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(noteIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  await ensureXhsSchema();
  const p = getPool();
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT note_id FROM xhs_published_notes WHERE note_id IN (${placeholders})`,
    ids,
  );
  const done = new Set<string>();
  for (const r of rows) done.add(String((r as { note_id: string }).note_id));
  return done;
}

/** 记录一篇已发布的笔记（幂等：同 note_id 覆盖最新来源/标题/链接）。 */
export async function markPublished(opts: {
  noteId: string;
  sourceUrl?: string;
  title?: string;
  shareLink?: string;
}): Promise<void> {
  if (!opts.noteId) return;
  await ensureXhsSchema();
  const p = getPool();
  await p.query(
    `INSERT INTO xhs_published_notes (note_id, source_url, title, share_link)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       source_url = VALUES(source_url),
       title = VALUES(title),
       share_link = VALUES(share_link)`,
    [
      opts.noteId,
      opts.sourceUrl ?? null,
      (opts.title ?? "").slice(0, 255) || null,
      opts.shareLink ?? null,
    ],
  );
}
