import { type NextRequest, NextResponse } from "next/server";

import { getCramCard, updateCramCardFsrs } from "@/lib/job-hunter/interview/cram";
import { nextReviewLabel, reviewFsrs, srStateFromStability, type RecallGrade } from "@/lib/job-hunter/interview/fsrs";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRADES: RecallGrade[] = ["forgot", "vague", "clear"];

/** 记忆卡自评复习:不记得/似乎记得/清楚 → FSRS 算下次到期。 */
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
    const upd = reviewFsrs(
      {
        difficulty: c.fsrs_difficulty ?? 0,
        stability: c.fsrs_stability ?? 0,
        state: c.fsrs_state,
        reps: c.repetitions,
        lapses: c.lapses,
        elapsedSec: c.elapsed_sec ?? null,
      },
      grade,
    );
    await updateCramCardFsrs(id, upd, grade);
    return NextResponse.json({
      success: true,
      intervalDays: upd.intervalDays,
      nextReviewLabel: nextReviewLabel(upd.intervalDays),
      state: srStateFromStability(true, upd.stability),
    });
  } catch (err) {
    return fail(err, "cram-card-review");
  }
}
