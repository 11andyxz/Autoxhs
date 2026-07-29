import type { NextRequest } from "next/server";

import { streamAnswer } from "@/lib/aiInterview/ai";
import type { QuestionKind } from "@/lib/aiInterview/question";
import { parseAnswerRequest } from "@/lib/aiInterview/schema";
import { sseResponse } from "@/lib/aiInterview/stream";
import { bad, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const QUESTION_KINDS = new Set([
  "behavioral",
  "technical",
  "coding",
  "logistics",
  "smalltalk",
  "unclear",
]);

/**
 * 「我现在该说什么」:按当前模式 + 简历/JD + 最近的对话,流式生成一段可以直接照着说的话。
 * 请求中断(用户换问题或点停)时 req.signal 会取消上游调用,不白烧 token。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const parsed = parseAnswerRequest(body);
  if (!parsed.question && !parsed.window.length && parsed.kind !== "ask") {
    return bad("还没有听到内容。");
  }

  const raw = (body as { questionKind?: unknown }).questionKind;
  const qKind =
    typeof raw === "string" && QUESTION_KINDS.has(raw) ? (raw as QuestionKind) : undefined;

  return sseResponse(streamAnswer(parsed, qKind, req.signal), `answer:${parsed.kind}`);
}
