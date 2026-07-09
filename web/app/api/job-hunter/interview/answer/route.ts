import { type NextRequest, NextResponse } from "next/server";

import { gradeAnswer } from "@/lib/job-hunter/interview/ai";
import { nextMastery } from "@/lib/job-hunter/interview/helpers";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { kbContextFor } from "@/lib/job-hunter/interview/kb";
import {
  getQuestion,
  getSkill,
  insertAnswer,
  updateQuestionSr,
  updateSkillMastery,
} from "@/lib/job-hunter/interview/repo";
import { nextReviewLabel, scheduleNext, scoreToQuality, srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ANSWER = 20_000;

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) return bad("请先作答再提交。");
  if (answer.length > MAX_ANSWER) return bad("答案过长,请精简后重试。");

  try {
    const q = await getQuestion(questionId);
    if (!q) return bad("题目不存在,请重新出题。", 404);

    const kbExcerpts = await kbContextFor(q.prompt);
    const grade = await gradeAnswer({
      question: q.prompt,
      referenceAnswer: q.reference_answer,
      rubric: q.rubric,
      answer,
      kbExcerpts,
    });

    const skill = await getSkill(q.skill_id);
    let mastery = skill?.mastery ?? grade.total;
    if (skill) {
      mastery = nextMastery(skill.mastery, skill.attempts, grade.total);
      await updateSkillMastery(skill.id, mastery, skill.attempts + 1);
    }
    await insertAnswer({
      questionId,
      skillId: q.skill_id,
      userText: answer,
      total: grade.total,
      grade,
    });

    // 间隔重复(遗忘曲线):按本次评分折算 quality,更新该题的下次到期时间。
    const sr = scheduleNext(
      {
        ease_factor: q.ease_factor,
        interval_days: q.interval_days,
        repetitions: q.repetitions,
        lapses: q.lapses,
      },
      scoreToQuality(grade.total),
    );
    await updateQuestionSr(questionId, sr, grade.total);

    // 评分后才揭示参考答案
    return NextResponse.json({
      success: true,
      grade,
      mastery,
      skillId: q.skill_id,
      referenceAnswer: q.reference_answer,
      review: {
        intervalDays: sr.interval_days,
        nextReviewLabel: nextReviewLabel(sr.interval_days),
        state: srState({ reviewed: true, interval_days: sr.interval_days }),
        passed: scoreToQuality(grade.total) >= 3,
      },
    });
  } catch (err) {
    return fail(err, "answer");
  }
}
