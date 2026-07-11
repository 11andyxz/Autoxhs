import { type NextRequest, NextResponse } from "next/server";

import { generateExplainExtras } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import {
  getExplain,
  getExplainExtras,
  getQuestion,
  listExplainNotes,
  saveExplainExtras,
} from "@/lib/job-hunter/interview/repo";
import { extractSvgText } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 讲解「附加料」:面试关键词 + SVG 示意图。
 * 已生成则直接返回(cached);否则据讲解文本生成并存库。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; regenerate?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  const regenerate = body.regenerate === true;
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");

  try {
    const coach = await getExplain(questionId);
    if (!coach) return bad("请先生成讲解。", 404);

    let extras = regenerate ? null : await getExplainExtras(questionId);
    let cached = true;
    if (!extras) {
      const q = await getQuestion(questionId);
      extras = await generateExplainExtras({
        question: q?.prompt ?? "",
        lesson: coach.lesson,
        modelAnswer: coach.modelAnswer,
      });
      await saveExplainExtras(questionId, extras);
      cached = false;
    }

    const notes = await listExplainNotes(questionId);
    return NextResponse.json({
      success: true,
      cached,
      keywords: extras.keywords,
      // 附上从 SVG 抽出的文字(供「图中文字划词翻译」)。
      diagrams: extras.diagrams.map((d) => ({ svg: d.svg, caption: d.caption, text: extractSvgText(d.svg) })),
      notes: notes.map((n) => ({ id: n.id, diagramOrd: n.diagram_ord, text: n.text })),
    });
  } catch (err) {
    return fail(err, "explain-extras");
  }
}
