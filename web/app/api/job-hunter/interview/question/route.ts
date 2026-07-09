import { type NextRequest, NextResponse } from "next/server";

import { generateQuestion } from "@/lib/job-hunter/interview/ai";
import { selectNextSkill } from "@/lib/job-hunter/interview/helpers";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { kbContextFor } from "@/lib/job-hunter/interview/kb";
import {
  getAskedPrompts,
  getSession,
  getSkill,
  getSkills,
  insertQuestion,
} from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { sessionId?: unknown; skillId?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在,请重新开始。", 404);

    const skills = await getSkills(sessionId);
    if (!skills.length) return bad("该会话没有可练习的技能。", 404);

    let skill = skills[0];
    if (body.skillId != null) {
      const picked = await getSkill(Number(body.skillId));
      if (picked && picked.session_id === sessionId) skill = picked;
    } else {
      skill = selectNextSkill(skills) ?? skills[0];
    }

    const kbExcerpts = await kbContextFor(`${skill.name} ${skill.category}`);
    const asked = await getAskedPrompts(sessionId);

    const gen = await generateQuestion({
      language: session.language,
      skill: skill.name,
      category: skill.category,
      jdText: session.jd_text,
      resumeText: session.resume_text,
      kbExcerpts,
      askedPrompts: asked,
    });

    const questionId = await insertQuestion({
      sessionId,
      skillId: skill.id,
      type: gen.type,
      prompt: gen.prompt,
      referenceAnswer: gen.referenceAnswer,
      rubric: gen.rubric,
    });

    // 不回传 referenceAnswer / rubric —— 答题前对候选人保密
    return NextResponse.json({
      success: true,
      questionId,
      skill: { id: skill.id, name: skill.name, category: skill.category },
      type: gen.type,
      prompt: gen.prompt,
    });
  } catch (err) {
    return fail(err, "question");
  }
}
