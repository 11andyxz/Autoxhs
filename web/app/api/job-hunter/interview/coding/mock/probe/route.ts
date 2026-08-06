import { type NextRequest, NextResponse } from "next/server";

import { askMockProbe } from "@/lib/job-hunter/interview/ai";
import { getCodingProblem } from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { codeIsEmpty, formatTurns, trimCode, type ProbeTurn } from "@/lib/job-hunter/interview/mockInterview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CODE_IN = 40_000;

/**
 * 面试模式:看着候选人此刻的代码追问一句。
 * 题面从库里取(前端只传 problemId + 现在的代码 + 已问过的),省得把整道题在网络上来回搬。
 */
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
    const starter = problem.setup ?? "";
    const probe = await askMockProbe({
      problem: problem.prompt_en || problem.prompt,
      starterCode: starter,
      code: trimCode(code),
      transcript: formatTurns(turns),
      elapsedSec,
      codeIsEmpty: codeIsEmpty(code, starter),
    });
    return NextResponse.json({ success: true, probe });
  } catch (err) {
    return fail(err, "mock-probe");
  }
}
