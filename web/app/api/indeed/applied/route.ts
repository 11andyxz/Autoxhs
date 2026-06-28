import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  rateLimitedResponse,
  transportErrorResponse,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/indeed/applied?jk= —— 转发 GET /indeed/applied，独立复核某岗位是否已投递。 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const jk = (searchParams.get("jk") ?? "").trim();
  if (!jk) {
    return NextResponse.json({ success: false, error: "缺少岗位 jk。" }, { status: 400 });
  }

  const result = await callIndeed("/indeed/applied", { query: { jk }, timeoutMs: 40_000 });
  if (result.kind !== "ok") return transportErrorResponse(result, "复核状态超时，请重试。");

  const json = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "无法复核投递状态。" },
      { status: 502 },
    );
  }

  const resultNode = (json.result ?? null) as Record<string, unknown> | null;
  return NextResponse.json({
    success: true,
    data: {
      jk: typeof json.jk === "string" ? json.jk : jk,
      applied: resultNode?.applied === true,
      appliedMs: typeof resultNode?.appliedMs === "number" ? resultNode.appliedMs : null,
    },
  });
}
