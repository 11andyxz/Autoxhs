import { type NextRequest, NextResponse } from "next/server";

import { answerAboutDiagram } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getExplain, getExplainExtras, getQuestion } from "@/lib/job-hunter/interview/repo";
import { extractSvgText } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_Q = 2000;

/** 「追问这张图」:据某张示意图 + 讲解回答候选人的问题(不评分、不存;答案由前端决定是否「添加」为笔记)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; diagramOrd?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  const diagramOrd = Number(body.diagramOrd);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  if (!Number.isInteger(diagramOrd) || diagramOrd < 0) return bad("缺少 diagramOrd。");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("请先输入你的问题。");
  if (question.length > MAX_Q) return bad("问题太长,请精简。");

  try {
    const coach = await getExplain(questionId);
    if (!coach) return bad("讲解不存在。", 404);
    const extras = await getExplainExtras(questionId);
    const diagram = extras?.diagrams?.[diagramOrd];
    if (!diagram) return bad("这张示意图不存在(可能已重新生成)。", 404);
    const q = await getQuestion(questionId);

    const answer = await answerAboutDiagram({
      questionPrompt: q?.prompt ?? "",
      diagramText: extractSvgText(diagram.svg),
      caption: diagram.caption,
      lesson: coach.lesson,
      followup: question,
    });
    return NextResponse.json({ success: true, answer });
  } catch (err) {
    return fail(err, "explain-ask");
  }
}
