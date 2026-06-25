import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getRecentAnswers, getSession, getSkills } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  const sessionId = Number(req.nextUrl.searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在。", 404);
    const [skills, recentAnswers] = await Promise.all([
      getSkills(sessionId),
      getRecentAnswers(sessionId),
    ]);
    return NextResponse.json({
      success: true,
      session: { id: session.id, language: session.language },
      skills,
      recentAnswers,
    });
  } catch (err) {
    return fail(err, "progress");
  }
}
