import { type NextRequest, NextResponse } from "next/server";

import { coachSkill } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { kbContextFor } from "@/lib/job-hunter/interview/kb";
import {
  getCoach,
  getSession,
  getSkill,
  getSkillWeaknesses,
  saveCoach,
} from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { sessionId?: unknown; skillId?: unknown; regenerate?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  const skillId = Number(body.skillId);
  const regenerate = body.regenerate === true;
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");
  if (!Number.isInteger(skillId) || skillId <= 0) return bad("缺少 skillId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在。", 404);
    const skill = await getSkill(skillId);
    if (!skill || skill.session_id !== sessionId) return bad("技能不存在。", 404);

    // 已生成过就一直用同一篇(便于理解记忆),除非显式「重新生成」。
    if (!regenerate) {
      const cached = await getCoach(skillId);
      if (cached) return NextResponse.json({ success: true, coach: cached, cached: true });
    }

    const weaknesses = await getSkillWeaknesses(skillId);
    const kbExcerpts = await kbContextFor(`${skill.name} ${skill.category}`);

    const coach = await coachSkill({
      language: session.language,
      skill: skill.name,
      weaknesses,
      jdText: session.jd_text,
      kbExcerpts,
    });
    await saveCoach(skillId, coach);
    return NextResponse.json({ success: true, coach, cached: false });
  } catch (err) {
    return fail(err, "coach");
  }
}
