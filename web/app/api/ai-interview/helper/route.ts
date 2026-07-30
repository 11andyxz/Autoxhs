import { spawn } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { bad, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 辅助程序启动时写的握手文件(权限 600,只有本人能读) */
const INFO_PATH = path.join(os.homedir(), ".autoxhs", "helper.json");
/** 仓库里的启动脚本(cwd 是 web/) */
const RUN_SH = path.join(process.cwd(), "..", "tools", "mac-audio-helper", "run.sh");
/** 辅助程序自己写的日志(权限指引在这里);run.sh 的输出落在仓库里那份 */
const HELPER_LOG = path.join(os.homedir(), ".autoxhs", "helper.log");
const LOG_PATH = path.join(process.cwd(), "..", "tools", "mac-audio-helper", "helper.log");

function isLocalHost(req: NextRequest): boolean {
  const host = (req.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

type Info = { port?: number; token?: string; pid?: number; startedAt?: number };

async function readInfo(): Promise<Info | null> {
  try {
    return JSON.parse(await readFile(INFO_PATH, "utf8")) as Info;
  } catch {
    return null;
  }
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 日志尾巴:启动失败时(最常见是屏幕录制权限没给)把原因带给页面 */
async function logTail(lines = 10): Promise<string> {
  for (const file of [HELPER_LOG, LOG_PATH]) {
    try {
      const text = (await readFile(file, "utf8")).trimEnd();
      if (text) return text.split("\n").slice(-lines).join("\n");
    } catch {
      /* 换下一个 */
    }
  }
  return "";
}

/**
 * 本机辅助程序在不在?在的话把端口和 token 给页面(页面直连 127.0.0.1 取系统声音/画面)。
 *
 * token 只交给**本机**打开的页面(和 /live/info 同一条规矩):副屏/手机拿不到,
 * 它们也不需要 —— 采集只发生在这台 Mac 上。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  if (!isLocalHost(req)) return bad("请在本机打开这个页面。", 403);

  const info = await readInfo();
  if (!info?.port || !info.token) {
    return NextResponse.json({
      success: true,
      available: false,
      reason: "not-running",
      logTail: await logTail(),
    });
  }
  if (info.pid && !alive(info.pid)) {
    return NextResponse.json({
      success: true,
      available: false,
      reason: "stale",
      logTail: await logTail(),
    });
  }

  return NextResponse.json({
    success: true,
    available: true,
    port: info.port,
    token: info.token,
    pid: info.pid ?? null,
    startedAt: info.startedAt ?? null,
  });
}

/**
 * 页面上那个「启动辅助程序 / 停止」按钮。
 *
 * 为什么点一下就能起:run.sh 会把辅助程序打成一个极小的 .app 并用 LaunchServices(open)启动,
 * 于是**它自己就是 TCC 的负责进程** —— 屏幕录制权限记在「Autoxhs Helper」名下,
 * 和「dev server 是从 Terminal 还是 Cursor 起的」彻底无关(踩过这个坑:从 Cursor 起的
 * dev server spawn 出来的裸二进制会被算在 Cursor 名下而被拒)。
 * 首次会弹系统授权框;没授权时启动失败的原因会经 logTail 原样带回页面,不让你对着按钮猜。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  if (!isLocalHost(req)) return bad("请在本机打开这个页面。", 403);

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    body = {};
  }
  const action =
    body.action === "stop"
      ? "stop"
      : body.action === "open-settings"
        ? "open-settings"
        : "start";

  // 直接把「屏幕录制」那一页打开,省得用户自己在设置里翻
  if (action === "open-settings") {
    try {
      spawn("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return NextResponse.json({ success: true, opened: true });
    } catch {
      return bad("打不开系统设置,请手动打开「隐私与安全性 → 屏幕录制」。", 500);
    }
  }
  const info = await readInfo();

  if (action === "stop") {
    if (!info?.pid || !alive(info.pid)) {
      return NextResponse.json({ success: true, stopped: false, reason: "not-running" });
    }
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      return bad("停不掉辅助程序,请在终端里 Ctrl-C。", 500);
    }
    return NextResponse.json({ success: true, stopped: true });
  }

  // 已经在跑就别再起一个(辅助程序自己也会拒绝,这里先挡一层)
  if (info?.pid && alive(info.pid)) {
    return NextResponse.json({ success: true, started: false, reason: "already-running" });
  }
  if (!existsSync(RUN_SH)) {
    return bad("找不到 tools/mac-audio-helper/run.sh。", 500);
  }

  try {
    // 日志追加到文件:spawn 出去之后就和这个请求无关了,失败原因只能靠日志带回来。
    const fd = openSync(LOG_PATH, "a");
    const child = spawn("bash", [RUN_SH], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: path.dirname(RUN_SH),
    });
    child.unref();
    return NextResponse.json({ success: true, started: true, pid: child.pid ?? null });
  } catch (err) {
    console.error("[ai-interview/helper] 启动失败", {
      name: (err as { name?: string } | null)?.name,
    });
    return bad("启动辅助程序失败,请在终端里手动跑 bash tools/mac-audio-helper/run.sh。", 500);
  }
}
