import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getQuestion, updateQuestionSr } from "@/lib/job-hunter/interview/repo";
import { gradeToQuality, nextReviewLabel, scheduleNext, srState, type RecallGrade } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 自评三档对应一个代表分,存进 last_score(仅记录/展示;经 scoreToQuality 折算回 1/3/5)。
const GRADE_SCORE: Record<RecallGrade, number> = { forgot: 30, vague: 68, clear: 92 };

/** 背答案闪卡:看完参考答案后自评「不记得/似乎记得/清楚」→ 直接排这道题的下次复习(遗忘曲线,不烧 AI)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; grade?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  const grade = body.grade;
  if (grade !== "forgot" && grade !== "vague" && grade !== "clear") return bad("自评档位无效。");

  try {
    const q = await getQuestion(questionId);
    if (!q) return bad("题目不存在。", 404);
    const sr = scheduleNext(
      { ease_factor: q.ease_factor, interval_days: q.interval_days, repetitions: q.repetitions, lapses: q.lapses },
      gradeToQuality(grade),
    );
    await updateQuestionSr(questionId, sr, GRADE_SCORE[grade]);
    return NextResponse.json({
      success: true,
      grade,
      intervalDays: sr.interval_days,
      nextReviewLabel: nextReviewLabel(sr.interval_days),
      state: srState({ reviewed: true, interval_days: sr.interval_days }),
    });
  } catch (err) {
    return fail(err, "self-rate");
  }
}
