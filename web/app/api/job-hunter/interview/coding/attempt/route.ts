import { type NextRequest, NextResponse } from "next/server";

import { getCodingProblem, recordCodingAttempt, updateCodingFsrs } from "@/lib/job-hunter/interview/coding";
import { nextReviewLabel, reviewFsrs, srStateFromStability, type RecallGrade } from "@/lib/job-hunter/interview/fsrs";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRADES: RecallGrade[] = ["forgot", "vague", "clear"];
const MODES = ["ghost", "blind"];

const int = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v)) || 0));

/** 敲完一遍:记成绩(wpm / 正确率 / 用时)+ 按自评走 FSRS 排下次复习。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: {
    problemId?: unknown;
    wpm?: unknown;
    accuracy?: unknown;
    durationSec?: unknown;
    keystrokes?: unknown;
    errors?: unknown;
    mode?: unknown;
    grade?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const problemId = Number(body.problemId);
  if (!Number.isInteger(problemId) || problemId <= 0) return bad("缺少题目 id。");
  const grade = body.grade as RecallGrade;
  if (!GRADES.includes(grade)) return bad("无效的掌握程度。");
  const mode = MODES.includes(body.mode as string) ? (body.mode as string) : "ghost";

  try {
    const p = await getCodingProblem(problemId);
    if (!p) return bad("题目不存在。", 404);

    await recordCodingAttempt({
      problemId,
      wpm: int(body.wpm, 500),
      accuracy: int(body.accuracy, 100),
      durationSec: int(body.durationSec, 86_400),
      keystrokes: int(body.keystrokes, 100_000),
      errors: int(body.errors, 100_000),
      mode,
      grade,
    });

    const upd = reviewFsrs(
      {
        difficulty: p.fsrs_difficulty ?? 0,
        stability: p.fsrs_stability ?? 0,
        state: p.fsrs_state,
        reps: p.repetitions,
        lapses: p.lapses,
        elapsedSec: p.elapsed_sec ?? null,
      },
      grade,
    );
    await updateCodingFsrs(problemId, upd, grade);

    return NextResponse.json({
      success: true,
      intervalDays: upd.intervalDays,
      nextReviewLabel: nextReviewLabel(upd.intervalDays),
      state: srStateFromStability(true, upd.stability),
    });
  } catch (err) {
    return fail(err, "coding-attempt");
  }
}
