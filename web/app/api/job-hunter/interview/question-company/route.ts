import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { setQuestionCompany } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 给某道题设/改「公司」标签(空字符串=未分类)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; company?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  const company = typeof body.company === "string" ? body.company.trim().slice(0, 120) : "";

  try {
    await setQuestionCompany(questionId, company);
    return NextResponse.json({ success: true, company });
  } catch (err) {
    return fail(err, "question-company");
  }
}
