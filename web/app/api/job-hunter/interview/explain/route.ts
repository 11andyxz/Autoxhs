import { type NextRequest, NextResponse } from "next/server";

import { explainQuestion } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { kbContextFor } from "@/lib/job-hunter/interview/kb";
import {
  getExplain,
  getExplainSr,
  getQuestion,
  getSession,
  saveExplain,
} from "@/lib/job-hunter/interview/repo";
import { nextReviewLabel } from "@/lib/job-hunter/interview/sr";

/** 讲解卡的遗忘曲线状态(给前端显示滑块默认值 + 下次复习)。 */
async function srSummary(questionId: number) {
  const sr = await getExplainSr(questionId);
  const reviewed = !!sr && sr.last_reviewed_at != null;
  return {
    lastPct: sr?.last_pct ?? null,
    reviewed,
    intervalDays: sr?.interval_days ?? 0,
    nextReviewLabel: reviewed ? nextReviewLabel(sr!.interval_days) : null,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 点「不会,直接看讲解」:按【这一道题】生成/取回讲解(区别于技能层面的 /coach)。 */
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
    const question = await getQuestion(questionId);
    if (!question) return bad("题目不存在。", 404);
    const session = await getSession(question.session_id);
    if (!session) return bad("训练会话不存在。", 404);

    // 已生成过就一直用同一篇(便于理解记忆),除非显式「重新生成」。
    if (!regenerate) {
      const cached = await getExplain(questionId);
      if (cached) {
        return NextResponse.json({
          success: true,
          coach: cached,
          cached: true,
          prompt: question.prompt,
          sr: await srSummary(questionId),
        });
      }
    }

    const kbExcerpts = await kbContextFor(question.prompt);
    const coach = await explainQuestion({
      language: session.language,
      question: question.prompt,
      referenceAnswer: question.reference_answer,
      kbExcerpts,
    });
    await saveExplain(questionId, coach);
    return NextResponse.json({
      success: true,
      coach,
      cached: false,
      prompt: question.prompt,
      sr: await srSummary(questionId),
    });
  } catch (err) {
    return fail(err, "explain");
  }
}
