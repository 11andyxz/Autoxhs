import { type NextRequest, NextResponse } from "next/server";

import { getCramCard, updateCramCardSr } from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { gradeToQuality, nextReviewLabel, scheduleNext, srState, type RecallGrade } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRADES: RecallGrade[] = ["forgot", "vague", "clear"];

/** 记忆卡自评复习:不记得/似乎记得/清楚 → SM-2 折算 quality → 排下次到期。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { id?: unknown; grade?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少卡片 id。");
  const grade = body.grade as RecallGrade;
  if (!GRADES.includes(grade)) return bad("无效的掌握程度。");

  try {
    const c = await getCramCard(id);
    if (!c) return bad("卡片不存在。", 404);
    const sr = scheduleNext(
      { ease_factor: c.ease_factor, interval_days: c.interval_days, repetitions: c.repetitions, lapses: c.lapses },
      gradeToQuality(grade),
    );
    await updateCramCardSr(id, sr, grade);
    return NextResponse.json({
      success: true,
      intervalDays: sr.interval_days,
      nextReviewLabel: nextReviewLabel(sr.interval_days),
      state: srState({ reviewed: true, interval_days: sr.interval_days }),
    });
  } catch (err) {
    return fail(err, "cram-card-review");
  }
}
