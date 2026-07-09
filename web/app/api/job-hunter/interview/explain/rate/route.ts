import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getExplainSr, rateExplain } from "@/lib/job-hunter/interview/repo";
import { nextReviewLabel, scheduleNext, scoreToQuality, srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 这道题的讲解复习:拖动「我理解了 X%」→ 折算成 SM-2 quality → 排下次复习。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; pct?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  const pct = Math.max(0, Math.min(100, Math.round(Number(body.pct))));
  if (!Number.isFinite(pct)) return bad("理解度无效。");

  try {
    const cur = await getExplainSr(questionId);
    if (!cur) return bad("该讲解不存在(请先生成)。", 404);
    const sr = scheduleNext(
      { ease_factor: cur.ease_factor, interval_days: cur.interval_days, repetitions: cur.repetitions, lapses: cur.lapses },
      scoreToQuality(pct),
    );
    await rateExplain(questionId, sr, pct);
    return NextResponse.json({
      success: true,
      pct,
      intervalDays: sr.interval_days,
      nextReviewLabel: nextReviewLabel(sr.interval_days),
      state: srState({ reviewed: true, interval_days: sr.interval_days }),
    });
  } catch (err) {
    return fail(err, "explain-rate");
  }
}
