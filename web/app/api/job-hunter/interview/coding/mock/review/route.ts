import { type NextRequest, NextResponse } from "next/server";

import { reviewMockSession } from "@/lib/job-hunter/interview/ai";
import { getCodingProblem, saveMockInterview } from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { formatTurns, trimCode, type ProbeTurn } from "@/lib/job-hunter/interview/mockInterview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CODE_IN = 40_000;

/** 面试模式:交卷 → AI 复盘 → 把这一场存下来(代码 + 问答 + 点评)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { problemId?: unknown; code?: unknown; turns?: unknown; elapsedSec?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const problemId = Number(body.problemId);
  if (!Number.isInteger(problemId) || problemId <= 0) return bad("缺少题目 id。");
  const code = typeof body.code === "string" ? body.code.slice(0, MAX_CODE_IN) : "";
  const elapsedSec = Math.max(0, Math.round(Number(body.elapsedSec)) || 0);
  const turns: ProbeTurn[] = (Array.isArray(body.turns) ? body.turns : [])
    .map((t) => t as Record<string, unknown>)
    .filter((t) => typeof t.question === "string" && t.question.trim())
    .map((t) => ({
      question: String(t.question),
      zh: typeof t.zh === "string" ? t.zh : "",
      kind: typeof t.kind === "string" ? t.kind : "followup",
      answer: typeof t.answer === "string" ? t.answer : "",
      askedAt: 0,
    }));

  try {
    const problem = await getCodingProblem(problemId);
    if (!problem) return bad("题目不存在。", 404);

    const review = await reviewMockSession({
      problem: problem.prompt_en || problem.prompt,
      reference: problem.solution,
      code: trimCode(code),
      transcript: formatTurns(turns, 20),
      elapsedSec,
    });

    // 复盘出来了才落库:一场没写完就关掉页面的不留记录,免得历史里全是空壳。
    let sessionId: number | null = null;
    try {
      sessionId = await saveMockInterview({
        problemId,
        title: problem.title,
        lang: problem.lang,
        code,
        turnsJson: JSON.stringify(turns),
        reviewJson: JSON.stringify(review),
        verdict: review.verdict,
        durationSec: elapsedSec,
      });
    } catch {
      // 存档失败不该把已经拿到的复盘吞掉 —— 照常返回,只是这场不进历史。
    }

    return NextResponse.json({ success: true, review, sessionId, solution: problem.solution });
  } catch (err) {
    return fail(err, "mock-review");
  }
}
