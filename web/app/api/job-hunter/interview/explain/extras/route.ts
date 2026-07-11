import { type NextRequest, NextResponse } from "next/server";

import { generateExplainExtras } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import {
  getExplain,
  getExplainExtras,
  getQuestion,
  listExplainImageOrds,
  saveExplainExtras,
} from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 讲解「附加料」:面试关键词 + SVG 示意图 + 生图计划。
 * 已生成则直接返回(cached);否则据讲解文本生成并存库。imagePlan 只把 caption/张数给前端,prompt 留后端。
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

    const cachedExtras = regenerate ? null : await getExplainExtras(questionId);
    let extras;
    let version: number;
    let cached = true;
    if (cachedExtras) {
      extras = cachedExtras;
      version = cachedExtras.version;
    } else {
      const q = await getQuestion(questionId);
      extras = await generateExplainExtras({
        question: q?.prompt ?? "",
        lesson: coach.lesson,
        modelAnswer: coach.modelAnswer,
      });
      version = await saveExplainExtras(questionId, extras); // 版本 +1 + 清旧配图
      cached = false;
    }

    const readyOrds = await listExplainImageOrds(questionId);
    return NextResponse.json({
      success: true,
      cached,
      extrasVersion: version,
      keywords: extras.keywords,
      diagrams: extras.diagrams,
      // 只暴露张数 + caption,别把生图 prompt 发给前端。
      imagePlan: extras.imagePlan.map((p) => ({ caption: p.caption })),
      readyOrds,
    });
  } catch (err) {
    return fail(err, "explain-extras");
  }
}
