import { type NextRequest, NextResponse } from "next/server";

import { buildFundamentals } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { clampImportance } from "@/lib/job-hunter/interview/schema";
import {
  countFundamentals,
  deleteFundamentals,
  getSession,
  getSkillIdMap,
  insertBankQuestions,
  insertSkills,
} from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TOPICS = 200;

/**
 * 生成「技术八股文」(concept 概念题)并入同一题库、存 Aiven。
 *  - topics 有值:只按这些技术出,追加进题库(不删已有)。
 *  - topics 空:按题库绑定简历的技术栈出,追加。
 *  - clear=true:清空该题库全部八股文。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { sessionId?: unknown; topics?: unknown; clear?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");
  const topics = typeof body.topics === "string" ? body.topics.trim().slice(0, MAX_TOPICS) : "";

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("题库不存在。", 404);

    // 清空八股文
    if (body.clear === true) {
      await deleteFundamentals(sessionId);
      return NextResponse.json({ success: true, count: 0, cleared: true });
    }

    const bank = await buildFundamentals({
      resumeText: session.resume_text,
      jdText: session.jd_text,
      topics,
    });

    // 每个技术当作一个技能(取最高 importance),先建技能再把题挂上。
    const skillMeta = new Map<string, { name: string; category: string; importance: number }>();
    for (const q of bank.questions) {
      const key = q.skill.toLowerCase();
      const prev = skillMeta.get(key);
      if (!prev || q.importance > prev.importance) {
        skillMeta.set(key, { name: q.skill, category: q.category, importance: clampImportance(q.importance) });
      }
    }
    await insertSkills(sessionId, Array.from(skillMeta.values()));
    const skillIdByName = await getSkillIdMap(sessionId);

    const items = bank.questions
      .map((q) => {
        const skillId = skillIdByName.get(q.skill.toLowerCase());
        if (!skillId) return null;
        return { skillId, type: q.type, prompt: q.prompt, referenceAnswer: q.referenceAnswer, rubric: q.rubric };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const added = await insertBankQuestions(sessionId, items, "fundamentals");
    const total = await countFundamentals(sessionId);
    return NextResponse.json({ success: true, added, count: total });
  } catch (err) {
    return fail(err, "fundamentals");
  }
}
