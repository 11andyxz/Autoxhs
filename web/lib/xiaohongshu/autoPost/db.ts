import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";

/**
 * 「每小时自动发一篇」的排期表。复用收费计算器的 MySQL 连接池（同一组 DB_* 变量）。
 *
 * 一天 = 24 行（slot 0~23，即计划发布的整点）。这张表同时承担三件事：
 *  1) **排期**：某天某个整点该发哪个主题；
 *  2) **补跑依据**：机器关机错过的整点，行还在且是 pending，开机后按序补发；
 *  3) **主题去重**：topic_key 全表唯一 —— 以前发过的主题不会再排进来。
 *
 * 状态机：pending → publishing → done / failed（failed 会被下一轮重新领取重试，
 * 超过 MAX_ATTEMPTS 才彻底放弃）；跨天未发的 pending 会被标成 missed（不积压到第二天）。
 */

export const SLOTS_PER_DAY = 24;
/** 同一个 slot 最多重试几次（含首次）。超过就放弃，不无限重试烧钱。 */
export const MAX_ATTEMPTS = 3;

export type SlotStatus = "pending" | "publishing" | "done" | "failed" | "missed";

export type PlanSlot = {
  id: number;
  planDate: string; // YYYY-MM-DD
  slot: number; // 0~23
  topic: string;
  status: SlotStatus;
  attempts: number;
  noteId: string | null;
  shareLink: string | null;
};

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表（幂等）。多次调用只执行一次。 */
export function ensureAutoPostSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS xhs_auto_post (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plan_date DATE NOT NULL,
        slot TINYINT NOT NULL,
        topic VARCHAR(255) NOT NULL,
        topic_key VARCHAR(191) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        title VARCHAR(255) NULL,
        sources TEXT NULL,
        note_id VARCHAR(64) NULL,
        share_link TEXT NULL,
        error TEXT NULL,
        published_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_auto_post_slot (plan_date, slot),
        UNIQUE KEY uk_auto_post_topic (topic_key),
        KEY idx_auto_post_day (plan_date, status)
      )
    `);
  })().catch((err) => {
    schemaReady = null; // 失败不缓存，下次重试建表
    throw err;
  });
  return schemaReady;
}

/**
 * 主题去重键：去掉空白与常见标点、转小写。
 * 「OPT 失业期怎么算？」和「OPT失业期怎么算」算同一个主题。
 */
export function topicKey(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[?？!！。，,、:：;；~～"'“”‘’()（）\[\]【】<>《》-]/g, "")
    .slice(0, 191);
}

/** 本机时区的 YYYY-MM-DD（排期按本机日历走，跟人的作息一致）。 */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 某天已经排了几个 slot。 */
export async function countPlanned(date: string): Promise<number> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM xhs_auto_post WHERE plan_date = ?`,
    [date],
  );
  return Number((rows[0] as { n?: number })?.n ?? 0);
}

/** 某天哪些 slot 已经占了（补排时跳过它们）。 */
export async function usedSlots(date: string): Promise<Set<number>> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT slot FROM xhs_auto_post WHERE plan_date = ?`,
    [date],
  );
  return new Set(rows.map((r) => Number((r as { slot: number }).slot)));
}

/**
 * 排期入库。topic_key 全表唯一 → 用 INSERT IGNORE 天然挡掉「跟历史某天重复的主题」，
 * 返回真正写进去的条数。
 */
export async function insertPlan(
  date: string,
  items: Array<{ slot: number; topic: string }>,
): Promise<number> {
  if (items.length === 0) return 0;
  await ensureAutoPostSchema();
  const p = getPool();
  let inserted = 0;
  for (const item of items) {
    const [res] = await p.query<ResultSetHeader>(
      `INSERT IGNORE INTO xhs_auto_post (plan_date, slot, topic, topic_key) VALUES (?, ?, ?, ?)`,
      [date, item.slot, item.topic.slice(0, 255), topicKey(item.topic)],
    );
    inserted += res.affectedRows > 0 ? 1 : 0;
  }
  return inserted;
}

/** 最近用过的主题（供生成新主题时避重；含未发布的排期）。 */
export async function recentTopics(limit = 300): Promise<string[]> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT topic FROM xhs_auto_post ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map((r) => String((r as { topic: string }).topic));
}

/**
 * 领取一个「到点了但还没发」的 slot（含之前失败的重试）。
 *
 * 先查后改、并用 `status IN ('pending','failed')` 做条件更新：affectedRows=0 说明被别人抢走了，
 * 换下一个。配合脚本侧的文件锁，足以防止同一 slot 被发两次。
 */
export async function claimDueSlot(date: string, maxSlot: number): Promise<PlanSlot | null> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, plan_date, slot, topic, status, attempts
       FROM xhs_auto_post
      WHERE plan_date = ? AND slot <= ? AND status IN ('pending','failed') AND attempts < ?
      ORDER BY slot ASC
      LIMIT 5`,
    [date, maxSlot, MAX_ATTEMPTS],
  );
  for (const row of rows) {
    const r = row as {
      id: number;
      plan_date: unknown;
      slot: number;
      topic: string;
      status: SlotStatus;
      attempts: number;
    };
    const [res] = await p.query<ResultSetHeader>(
      `UPDATE xhs_auto_post
          SET status = 'publishing', attempts = attempts + 1, error = NULL
        WHERE id = ? AND status IN ('pending','failed')`,
      [r.id],
    );
    if (res.affectedRows > 0) {
      return {
        id: r.id,
        planDate: date,
        slot: Number(r.slot),
        topic: r.topic,
        status: "publishing",
        attempts: Number(r.attempts) + 1,
        noteId: null,
        shareLink: null,
      };
    }
  }
  return null;
}

/** 发布成功：记下笔记 id / 链接 / 实际标题 / 引用来源。 */
export async function markSlotDone(
  id: number,
  info: { noteId?: string | null; shareLink?: string | null; title?: string; sources?: string },
): Promise<void> {
  await ensureAutoPostSchema();
  const p = getPool();
  await p.query(
    `UPDATE xhs_auto_post
        SET status = 'done', note_id = ?, share_link = ?, title = ?, sources = ?,
            published_at = NOW(), error = NULL
      WHERE id = ?`,
    [
      info.noteId ?? null,
      info.shareLink ?? null,
      (info.title ?? "").slice(0, 255) || null,
      (info.sources ?? "").slice(0, 2000) || null,
      id,
    ],
  );
}

/**
 * 这一轮失败：记错误原因。attempts 已在领取时 +1，
 * 还没到上限就退回可重试状态（下一轮再领），到了上限就留在 failed 不再领取。
 */
export async function markSlotFailed(id: number, error: string): Promise<void> {
  await ensureAutoPostSchema();
  const p = getPool();
  await p.query(`UPDATE xhs_auto_post SET status = 'failed', error = ? WHERE id = ?`, [
    error.slice(0, 1000),
    id,
  ]);
}

/**
 * 把「更早日期还没发出去」的排期标成 missed。
 * 不让昨天的积压涌进今天 —— 今天自己有 24 篇，再叠上昨天的必然触发风控。
 */
export async function expireOldSlots(beforeDate: string): Promise<number> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [res] = await p.query<ResultSetHeader>(
    `UPDATE xhs_auto_post SET status = 'missed'
      WHERE plan_date < ? AND status IN ('pending','failed','publishing')`,
    [beforeDate],
  );
  return res.affectedRows;
}

/**
 * 卡在 publishing 太久（上一轮崩了/被 kill）的行，收掉。
 *
 * ⚠️ 收成 **missed（不再重试）**，不是 failed。卡住的原因很可能是「笔记已经发出去了，
 * 只是记账那一步失败」—— 重试就会重复发一篇。宁可漏一个整点，也不要重复公开。
 * 日志里会写明是哪一行，需要的话人工判断后手动改回 pending。
 *
 * 阈值要大于「一篇最慢能跑多久」：查证/复核各带 3 次重试，最坏情况一篇能跑 40 分钟以上，
 * 阈值太小会在人家还在跑的时候就把行收走（不会重复发，但会白跑一篇）。
 */
export async function releaseStaleClaims(staleMinutes = 60): Promise<number> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [res] = await p.query<ResultSetHeader>(
    `UPDATE xhs_auto_post
        SET status = 'missed',
            error = COALESCE(error, '上一轮中断，结果未知（不自动重试，避免重复发布）')
      WHERE status = 'publishing' AND updated_at < (NOW() - INTERVAL ? MINUTE)`,
    [Math.max(1, Math.floor(staleMinutes))],
  );
  return res.affectedRows;
}

/** 上一次成功发布的时间（Unix 毫秒）。用来做「两篇之间至少隔多久」的节流。 */
export async function lastPublishedAt(): Promise<number | null> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT UNIX_TIMESTAMP(MAX(published_at)) AS ts FROM xhs_auto_post WHERE status = 'done'`,
  );
  const ts = (rows[0] as { ts?: number | string | null } | undefined)?.ts;
  if (ts == null) return null;
  const n = Number(ts);
  return Number.isFinite(n) ? n * 1000 : null;
}

export type DayStats = { total: number; done: number; pending: number; failed: number };

/** 某天的完成情况（日志/巡检用）。 */
export async function dayStats(date: string): Promise<DayStats> {
  await ensureAutoPostSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS n FROM xhs_auto_post WHERE plan_date = ? GROUP BY status`,
    [date],
  );
  const stats: DayStats = { total: 0, done: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    const r = row as { status: SlotStatus; n: number };
    const n = Number(r.n);
    stats.total += n;
    if (r.status === "done") stats.done += n;
    else if (r.status === "pending" || r.status === "publishing") stats.pending += n;
    else if (r.status === "failed") stats.failed += n;
  }
  return stats;
}
