import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getKnowledge, updateKnowledgeSr } from "@/lib/job-hunter/interview/repo";
import { gradeToQuality, nextReviewLabel, scheduleNext, srState, type RecallGrade } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRADES: RecallGrade[] = ["forgot", "vague", "clear"];

/** 知识块自评复习:不记得/似乎记得/清楚 → SM-2 折算 quality → 排下次到期(与单词同口径)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { id?: unknown; grade?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少知识块 id。");
  const grade = body.grade as RecallGrade;
  if (!GRADES.includes(grade)) return bad("无效的掌握程度。");

  try {
    const k = await getKnowledge(id);
    if (!k) return bad("知识块不存在。", 404);
    const sr = scheduleNext(
      { ease_factor: k.ease_factor, interval_days: k.interval_days, repetitions: k.repetitions, lapses: k.lapses },
      gradeToQuality(grade),
    );
    await updateKnowledgeSr(id, sr, grade);
    return NextResponse.json({
      success: true,
      intervalDays: sr.interval_days,
      nextReviewLabel: nextReviewLabel(sr.interval_days),
      state: srState({ reviewed: true, interval_days: sr.interval_days }),
    });
  } catch (err) {
    return fail(err, "knowledge-review");
  }
}
