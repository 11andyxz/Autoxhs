import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getQuestion } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 背答案闪卡:直接揭示这道题的参考答案(不评分、不烧 AI)。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const questionId = Number(req.nextUrl.searchParams.get("questionId"));
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  try {
    const q = await getQuestion(questionId);
    if (!q) return bad("题目不存在。", 404);
    return NextResponse.json({ success: true, referenceAnswer: q.reference_answer, prompt: q.prompt });
  } catch (err) {
    return fail(err, "answer-key");
  }
}
