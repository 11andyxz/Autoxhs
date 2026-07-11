import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import {
  getBankList,
  getRecentAnswers,
  getSession,
  getSkills,
  getSrCounts,
} from "@/lib/job-hunter/interview/repo";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  const sessionId = Number(req.nextUrl.searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在。", 404);
    const [skills, recentAnswers, srCounts, bankRows] = await Promise.all([
      getSkills(sessionId),
      getRecentAnswers(sessionId),
      getSrCounts(sessionId),
      getBankList(sessionId),
    ]);
    const bank = bankRows.map((b) => ({
      id: b.id,
      skillId: b.skill_id,
      skill: b.skill,
      category: b.category,
      type: b.type,
      prompt: b.prompt,
      state: srState({ reviewed: b.last_reviewed_at != null, interval_days: b.interval_days }),
      isDue: b.is_due === 1,
      lastScore: b.last_score,
      intervalDays: b.interval_days,
      dueAt: b.due_at,
      lastReviewedAt: b.last_reviewed_at,
      source: b.source,
      company: b.company,
    }));
    return NextResponse.json({
      success: true,
      session: { id: session.id, language: session.language, mode: session.mode, title: session.title },
      skills,
      recentAnswers,
      srCounts,
      bank,
    });
  } catch (err) {
    return fail(err, "progress");
  }
}
