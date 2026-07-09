import { type NextRequest, NextResponse } from "next/server";

import { polishToEnglish } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getQuestion } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ANSWER = 20_000;

/**
 * 面试「转成英文面试版」:拿候选人的作答(常为中文/混合),结合题目与理想答案的语境,
 * 改写成可直接说出口的英文面试作答(保留其真实内容,不编造)。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) return bad("请先写下你的作答(可用中文)。");
  if (answer.length > MAX_ANSWER) return bad("作答过长,请精简后重试。");

  try {
    const q = await getQuestion(questionId);
    if (!q) return bad("题目不存在,请重新出题。", 404);

    const english = await polishToEnglish({
      question: q.prompt,
      referenceAnswer: q.reference_answer,
      userAnswer: answer,
    });
    return NextResponse.json({ success: true, english });
  } catch (err) {
    return fail(err, "englishify");
  }
}
