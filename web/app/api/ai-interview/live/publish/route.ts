import { NextResponse, type NextRequest } from "next/server";

import { checkCode, publishLive, viewerCount } from "@/lib/aiInterview/liveHub";
import { parseLiveState } from "@/lib/aiInterview/schema";
import { bad, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 主页面推一帧给副屏。生成答案时会连着推很多帧(前端已按 ~150ms 节流),
 * 所以这里要尽量轻:校验 + 写内存 + 广播,不落库、不调模型。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  if (!checkCode(typeof body.k === "string" ? body.k : null)) {
    return bad("配对码不对。", 403);
  }

  // 归属权:同一台机器上可能留着好几个 Autoxhs 页面,只有最新那个能往副屏写
  // (否则手机会在两场面试之间来回跳,见 liveHub 的注释)。
  const id = typeof body.pubId === "string" ? body.pubId.slice(0, 64) : "";
  if (!id) return bad("缺少页面标识。");
  const startedAt =
    typeof body.pubStartedAt === "number" && Number.isFinite(body.pubStartedAt)
      ? body.pubStartedAt
      : 0;

  const { state, accepted } = publishLive({ id, startedAt }, parseLiveState(body.state));
  return NextResponse.json({
    success: true,
    accepted,
    v: state.v,
    viewers: viewerCount(),
  });
}
