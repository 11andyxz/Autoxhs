import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  rateLimitedResponse,
  transportErrorResponse,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/indeed/health —— 转发 GET /indeed/health，返回服务与登录态。 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const result = await callIndeed("/indeed/health", { timeoutMs: 10_000 });
  if (result.kind !== "ok") return transportErrorResponse(result, "服务状态检查超时，请重试。");

  const json = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "服务状态异常。" },
      { status: 502 },
    );
  }

  const applicant = (json.applicant ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    success: true,
    data: {
      ok: true,
      sessionCookies: typeof json.session_cookies === "number" ? json.session_cookies : 0,
      hasIndeedCsrf: json.has_indeed_csrf === true,
      cdpConnected: json.cdp_connected === true,
      applicant: {
        firstName: typeof applicant.first_name === "string" ? applicant.first_name : "",
        lastName: typeof applicant.last_name === "string" ? applicant.last_name : "",
        email: typeof applicant.email === "string" ? applicant.email : "",
      },
    },
  });
}
