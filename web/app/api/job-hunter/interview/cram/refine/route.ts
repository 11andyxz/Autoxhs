import { type NextRequest, NextResponse } from "next/server";

import { refineAnswer } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ANSWER = 8000;
const MAX_QUESTION = 2000;

/** AI 润色:把答案(常抄自粗糙题库)的语法/表达/逻辑改对,不加内容。{question?, answer} → {refined}。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { question?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, MAX_ANSWER) : "";
  if (!answer) return bad("这张卡没有可润色的内容。");
  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";

  try {
    const { refined, notes } = await refineAnswer({ question, answer });
    return NextResponse.json({ success: true, refined, notes });
  } catch (err) {
    return fail(err, "cram-refine");
  }
}
