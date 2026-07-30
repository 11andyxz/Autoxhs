import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { NextResponse, type NextRequest } from "next/server";

import { bad, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 辅助程序启动时写的握手文件(权限 600,只有本人能读) */
const INFO_PATH = path.join(os.homedir(), ".autoxhs", "helper.json");

function isLocalHost(req: NextRequest): boolean {
  const host = (req.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
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

  let info: { port?: number; token?: string; pid?: number; startedAt?: number };
  try {
    info = JSON.parse(await readFile(INFO_PATH, "utf8"));
  } catch {
    return NextResponse.json({ success: true, available: false, reason: "not-running" });
  }

  if (!info.port || !info.token) {
    return NextResponse.json({ success: true, available: false, reason: "bad-info" });
  }
  // 进程还活着吗?(signal 0 只探测存在性,不真的发信号)
  if (info.pid) {
    try {
      process.kill(info.pid, 0);
    } catch {
      return NextResponse.json({ success: true, available: false, reason: "stale" });
    }
  }

  return NextResponse.json({
    success: true,
    available: true,
    port: info.port,
    token: info.token,
    startedAt: info.startedAt ?? null,
  });
}
