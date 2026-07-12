import { type NextRequest, NextResponse } from "next/server";

import { answerAboutVocab } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_Q = 2000;

/** 「问一下这个词」:据词/释义/例句回答候选人的问题(不存;答案由前端决定是否加入知识块)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { term?: unknown; zh?: unknown; example?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const term = typeof body.term === "string" ? body.term.trim() : "";
  if (!term) return bad("缺少单词。");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("请先输入你的问题。");
  if (question.length > MAX_Q) return bad("问题太长,请精简。");
  const zh = typeof body.zh === "string" ? body.zh.slice(0, 1000) : "";
  const example = typeof body.example === "string" ? body.example.slice(0, 2000) : "";

  try {
    const answer = await answerAboutVocab({ term, zh, example, question });
    return NextResponse.json({ success: true, answer });
  } catch (err) {
    return fail(err, "vocab-ask");
  }
}
