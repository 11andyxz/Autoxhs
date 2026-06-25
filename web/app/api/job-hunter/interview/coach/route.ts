import { type NextRequest, NextResponse } from "next/server";

import { coachSkill } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { kbContextFor } from "@/lib/job-hunter/interview/kb";
import { getSession, getSkill, getSkillWeaknesses } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { sessionId?: unknown; skillId?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  const skillId = Number(body.skillId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");
  if (!Number.isInteger(skillId) || skillId <= 0) return bad("缺少 skillId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在。", 404);
    const skill = await getSkill(skillId);
    if (!skill || skill.session_id !== sessionId) return bad("技能不存在。", 404);

    const weaknesses = await getSkillWeaknesses(skillId);
    const kbExcerpts = await kbContextFor(`${skill.name} ${skill.category}`);

    const coach = await coachSkill({
      language: session.language,
      skill: skill.name,
      weaknesses,
      jdText: session.jd_text,
      kbExcerpts,
    });
    return NextResponse.json({ success: true, coach });
  } catch (err) {
    return fail(err, "coach");
  }
}
