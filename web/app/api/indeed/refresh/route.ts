import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  rateLimitedResponse,
  transportErrorResponse,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/indeed/refresh —— 转发 POST /indeed/refresh：
 * 让本地服务重载 session.json 并断开 CDP（下次投递重连）。重采登录态后调用。
 */
export async function POST(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const result = await callIndeed("/indeed/refresh", { method: "POST", timeoutMs: 30_000 });
  if (result.kind !== "ok") return transportErrorResponse(result, "重载会话超时，请重试。");

  const json = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "重载会话失败。" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    data: { note: typeof json.note === "string" ? json.note : "已重载会话。" },
  });
}
