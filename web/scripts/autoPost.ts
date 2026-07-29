/**
 * 「每小时自动发一篇 OPT 笔记」的定时入口。由 launchd 定时唤醒调用
 * （见 scripts/auto-post.sh + scripts/launchd/com.autoxhs.auto-post.plist）。
 *
 * 每次唤醒只是「检查」：当天排期没排就排，到点了才发，且距上一篇不足 MIN_GAP 分钟不发。
 * 关机错过的整点，开机后按轮次逐篇补上（见 lib/xiaohongshu/autoPost/run.ts）。
 *
 * 用法：
 *   npm run post:auto                 # 正式（受 AUTO_POST_ENABLED + 排期 + 节流约束）
 *   npm run post:auto:dry             # 干跑：查证→写稿→拆卡→渲染→上传，但**不发布**
 *   npm run post:auto -- --now --count 2 --privacy 1
 *                                     # 手动验收：无视整点，连发 2 篇「仅自己可见」
 *   npm run post:auto -- --plan-only  # 只生成/补齐当天 24 个选题，不发
 *
 * 前提：本地 rednote 服务(3456) 在跑、AdsPower 已登录小红书；.env.local 配好 OPENAI 与 DB 等变量。
 * 安全：总开关 AUTO_POST_ENABLED 默认「关」；未开启时正式运行只打印提示就退出。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false);

const LOCK_FILE = path.join(os.tmpdir(), "autoxhs-auto-post.lock");
/**
 * 一篇的流水线（查证+写稿+复核+渲染+上传+发布）正常 6~8 分钟，
 * 但查证与复核各带 3 次重试，最坏情况能拖到 40 分钟以上 —— 阈值取 60 分钟，
 * 且要与 db.ts 的 releaseStaleClaims 保持一致，避免「锁还在、行已被收走」。
 */
const LOCK_STALE_MS = 60 * 60 * 1000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function intArg(name: string, fallback: number | null): number | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

async function main(): Promise<number> {
  const { readAutoPostConfig, runAutoPostTick } = await import("@/lib/xiaohongshu/autoPost/run");
  const { ensureDailyPlan } = await import("@/lib/xiaohongshu/autoPost/plan");
  const { localDate, dayStats } = await import("@/lib/xiaohongshu/autoPost/db");

  const dryRun = process.argv.includes("--dry-run");
  const planOnly = process.argv.includes("--plan-only");
  const ignoreSchedule = process.argv.includes("--now");
  const cfg = {
    ...readAutoPostConfig(),
    dryRun,
    ignoreSchedule,
  };
  const count = intArg("--count", null);
  if (count !== null) cfg.maxPerTick = Math.min(24, Math.max(1, count));
  const privacy = intArg("--privacy", null);
  if (privacy !== null) cfg.privacy = privacy === 1 ? 1 : 0;

  if (planOnly) {
    const date = localDate();
    log(`=== 只排期（${date}）===`);
    const r = await ensureDailyPlan(date, {
      theme: cfg.theme,
      count: cfg.perDay,
      fromSlot: new Date().getHours(),
      log,
    });
    log(`排期结果：新增 ${r.created}，当天共 ${r.total} 个。`);
    log(`当天状态：${JSON.stringify(await dayStats(date))}`);
    return 0;
  }

  if (dryRun) {
    log("=== auto-post 干跑开始（会真渲染真上传图片，但不发布）===");
  } else {
    log("=== auto-post 开始 ===");
    if (!cfg.enabled) {
      log(
        "AUTO_POST_ENABLED 未开启（默认关）。确认无误后在 .env.local 设 AUTO_POST_ENABLED=1 才会真正发布。本次不执行。",
      );
      return 0;
    }
  }
  log(
    `配置：每天 ${cfg.perDay} 篇 · 单轮最多 ${cfg.maxPerTick} 篇 · 间隔≥${cfg.minGapMin} 分钟 · ` +
      `可见性=${cfg.privacy === 1 ? "仅自己可见" : "公开"} · 原创=${cfg.original}` +
      (ignoreSchedule ? " · 无视整点(手动)" : ""),
  );

  // 防重入锁：上一篇还在跑（渲染/上传都不快）时，下一次唤醒直接跳过
  let locked = false;
  if (!dryRun) {
    try {
      const st = fs.statSync(LOCK_FILE);
      if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
        log(`检测到运行中的实例（锁 ${LOCK_FILE} 未过期），本次跳过。`);
        return 0;
      }
      log("发现过期的锁，忽略并接管。");
    } catch {
      /* 无锁文件，正常 */
    }
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid));
      locked = true;
    } catch (e) {
      log(`写锁失败（${(e as Error)?.message}），谨慎起见本次跳过。`);
      return 0;
    }
  }

  try {
    const result = await runAutoPostTick(cfg, log);
    if (!result.ran) {
      log(`未执行：${result.reason}`);
      return 0;
    }
    for (const o of result.outcomes) {
      if (!o.ok) continue;
      log(
        `结果 [${o.slot}:00]「${o.title}」${o.angle ? `· ${o.angle} ` : ""}${o.cards} 张 · 话题 ${o.tags?.length ?? 0} 个` +
          (o.missingTags?.length ? `（丢弃 ${o.missingTags.join("、")}）` : "") +
          (o.shareLink ? ` · ${o.shareLink}` : ""),
      );
      for (const s of o.sources ?? []) log(`  ${s}`);
    }
    log(
      `本轮发布 ${result.published} 篇；${result.date} 累计 ` +
        `${result.stats?.done ?? 0}/${result.stats?.total ?? 0}（待发 ${result.stats?.pending ?? 0}，失败 ${result.stats?.failed ?? 0}）。`,
    );
    return 0;
  } finally {
    if (locked) {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* 忽略 */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`未捕获错误：${(err as Error)?.stack ?? err}`);
    process.exit(1);
  });
