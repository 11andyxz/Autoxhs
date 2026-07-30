import { NextResponse, type NextRequest } from "next/server";

import { lanHosts, liveCode, viewerCount } from "@/lib/aiInterview/liveHub";
import { bad, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只有从本机(localhost)访问才给配对码 —— 同一个 WiFi 上的别人问不到。 */
function isLocalHost(req: NextRequest): boolean {
  const host = (req.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * 主页面用这个拿「手机要打开的地址」:局域网 IP + 当前端口 + 配对码。
 *
 * 注意这层保护是「够用」级别的:Host 头是客户端说的,局域网里的人硬写 Host: localhost
 * 也能问到码。真正的门槛是码本身不可猜(6 位、约 20 亿种)。要更严就给站点设 APP_PASSWORD。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  if (!isLocalHost(req)) return bad("请在本机打开这个页面。", 403);

  const host = req.headers.get("host") || "";
  const port = host.includes(":") ? host.split(":")[1] : "3100";
  const code = liveCode();
  const hosts = lanHosts();

  return NextResponse.json({
    success: true,
    code,
    port,
    viewers: viewerCount(),
    // 手机上照着敲的完整地址(多网卡就多给几个,挑能通的)
    urls: hosts.map((ip) => `http://${ip}:${port}/ai-interview/view?k=${code}`),
  });
}
