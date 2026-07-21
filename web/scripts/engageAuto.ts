/**
 * 「每天自动评论」定时入口。由 launchd 每小时唤醒调用（见 scripts/engage-auto.sh + launchd plist）。
 * 真正发不发由 lib/xiaohongshu/engageAuto.ts 里的 24h 闸门 + 总开关决定。
 *
 * 用法：
 *   npm run engage:auto          # 正式运行（受 ENGAGE_AUTO_ENABLED 与 24h 闸门约束）
 *   npm run engage:auto:dry      # 干跑：取笔记 + 生成评论并打印，但绝不发布、不记录
 *
 * 前提：本地 rednote 服务(3456) 在跑、AdsPower 已登录小红书；.env.local 里配好 OPENAI 与 DB 等变量。
 * 安全：总开关 ENGAGE_AUTO_ENABLED 默认「关」；未开启时正式运行只会打印提示并退出，不发任何东西。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

// 先加载 .env.local（Next 同款优先级），再用到 OPENAI_*/DB_*/REDNOTE_* 等。
loadEnvConfig(process.cwd(), false);

const LOCK_FILE = path.join(os.tmpdir(), "autoxhs-engage-auto.lock");
const LOCK_STALE_MS = 30 * 60 * 1000; // 锁超过 30 分钟视为过期（上一轮异常残留）

function stamp(): string {
  return new Date().toISOString();
}
function log(msg: string): void {
  console.log(`[${stamp()}] ${msg}`);
}

async function main(): Promise<number> {
  // 动态 import：确保在 loadEnvConfig 之后再解析这些模块（它们内部在函数里读 env，其实先后都行，
  // 这里显式动态导入只是让「先装环境、再跑逻辑」的意图更清楚）。
  const { readAutoConfig, runEngageAuto } = await import("@/lib/xiaohongshu/engageAuto");

  const dryRun = process.argv.includes("--dry-run");
  const cfg = { ...readAutoConfig(), dryRun };

  if (dryRun) {
    log("=== engage-auto 干跑开始（不会发布任何东西）===");
  } else {
    log("=== engage-auto 开始 ===");
    if (!cfg.enabled) {
      log("ENGAGE_AUTO_ENABLED 未开启（默认关）。确认无误后在 .env.local 设 ENGAGE_AUTO_ENABLED=1 才会真正发评论。本次不执行。");
      return 0;
    }
  }
  log(
    `配置：count=${cfg.count} pages=${cfg.pages} 间隔=${cfg.minIntervalSec}-${cfg.maxIntervalSec}s ` +
      `闸门=${cfg.intervalHours}h 赞评论=${cfg.likeComment} 赞帖=${cfg.likeNote}` +
      (cfg.styleHint ? ` 风格="${cfg.styleHint}"` : ""),
  );

  // 防重入锁（dry-run 不加锁，随时可跑）
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
    const result = await runEngageAuto(cfg, log);
    log(`结果：${JSON.stringify(result)}`);
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
