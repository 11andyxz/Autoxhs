import { type NextRequest, NextResponse } from "next/server";

import { answerCustomQuestion } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getSession, getSkillIdMap, insertBankQuestions, insertSkills } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_QUESTION = 4000;

/**
 * 「加一道自己的题」:用户给一道面试题 → AI 生成参考答案 + 分类 → 加入题库(source=custom)。
 * 返回参考答案,前端当场展示。可带 company 归类。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { sessionId?: unknown; question?: unknown; company?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("请先输入你的面试题。");
  if (question.length > MAX_QUESTION) return bad("题目太长,请精简。");
  const company = typeof body.company === "string" ? body.company.trim().slice(0, 120) : "";

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("题库不存在。", 404);

    const ans = await answerCustomQuestion({
      question: question.slice(0, MAX_QUESTION),
      resumeText: session.resume_text,
      jdText: session.jd_text,
    });

    await insertSkills(sessionId, [{ name: ans.skill, category: ans.category, importance: ans.importance }]);
    const skillIdByName = await getSkillIdMap(sessionId);
    const skillId = skillIdByName.get(ans.skill.toLowerCase());
    if (!skillId) return fail(new Error("skill map miss"), "custom-question");

    await insertBankQuestions(
      sessionId,
      [{ skillId, type: ans.type, prompt: question, referenceAnswer: ans.referenceAnswer, rubric: ans.rubric }],
      "custom",
      company,
    );

    return NextResponse.json({
      success: true,
      referenceAnswer: ans.referenceAnswer,
      skill: ans.skill,
      category: ans.category,
      type: ans.type,
    });
  } catch (err) {
    return fail(err, "custom-question");
  }
}
