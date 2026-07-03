import { NextResponse, type NextRequest } from "next/server";

import { matchQuestions } from "@/lib/indeed/kb";
import {
  callIndeed,
  extractServiceError,
  normalizeQuestions,
  rateLimitedResponse,
  transportErrorResponse,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/indeed/questions?jk= —— 转发 GET /indeed/questions，
 * 返回该岗位的雇主资格问题及本地服务按默认策略给出的自动答案（前端只读展示）。
 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const jk = (searchParams.get("jk") ?? "").trim();
  if (!jk) {
    return NextResponse.json({ success: false, error: "缺少岗位 jk。" }, { status: 400 });
  }

  const result = await callIndeed("/indeed/questions", { query: { jk }, timeoutMs: 40_000 });
  if (result.kind !== "ok") return transportErrorResponse(result, "读取雇主问题超时，请重试。");

  const json = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "无法读取该岗位的雇主问题。" },
      { status: 502 },
    );
  }

  const questions = normalizeQuestions(json.questions);
  // 附上知识库命中(精确/相似),供前端预填答案;KB 出错不影响问题本身返回。
  const matches = await matchQuestions(questions);
  return NextResponse.json({
    success: true,
    data: {
      jk: typeof json.jk === "string" ? json.jk : jk,
      draftId: typeof json.draft_id === "string" ? json.draft_id : "",
      count: questions.length,
      questions,
      matches,
    },
  });
}
