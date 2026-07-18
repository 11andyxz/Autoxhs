import { type NextRequest, NextResponse } from "next/server";

import { answerAboutResume } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PASSAGE = 8000;
const MAX_CONTEXT = 4000;
const MAX_Q = 2000;

/** 「追问这段」:据选中段落 + 文档上下文,回答候选人的问题(中文)。不落库,前端可选存成知识块。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { passage?: unknown; context?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const passage = typeof body.passage === "string" ? body.passage.trim().slice(0, MAX_PASSAGE) : "";
  if (!passage) return bad("没有选中的内容。");
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT) : "";
  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_Q) : "";
  if (!question) return bad("请输入你的问题。");

  try {
    const answer = await answerAboutResume({ passage, context, question });
    return NextResponse.json({ success: true, answer });
  } catch (err) {
    return fail(err, "cram-ask");
  }
}
