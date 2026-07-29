import { type NextRequest, NextResponse } from "next/server";

import { getCodingProblem } from "@/lib/job-hunter/interview/coding";
import { addCramCard, getCramSession, listCramFrontKeys } from "@/lib/job-hunter/interview/cram";
import { frontKey } from "@/lib/job-hunter/interview/frontKey";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 把一道 Coding 跟打题塞进「猛攻版」的复习队列(ip_cram_card),和其它卡一起按遗忘曲线过、也会被自动念题。
 * 正面用英文题干(面试怎么问就怎么念),背面是参考代码 + 中文题干 + 考点。
 * 代码本身仍留在 Coding 题库里照常敲 —— 这边练的是「张嘴说得出来」。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { problemId?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const problemId = Number(body.problemId);
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(problemId) || problemId <= 0) return bad("缺少题目 id。");
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少简历 id。");

  try {
    const [problem, session] = await Promise.all([getCodingProblem(problemId), getCramSession(sessionId)]);
    if (!problem) return bad("题目不存在。", 404);
    if (!session) return bad("这份简历不存在。", 404);

    const front = (problem.prompt_en || problem.prompt || problem.title).trim();
    const parts = [
      problem.solution,
      "",
      problem.prompt,
      problem.setup ? `上下文：${problem.setup}` : "",
      problem.explanation ? `考点：${problem.explanation}` : "",
    ].filter((s) => s !== "");
    const content = parts.join("\n");

    // 同一道题重复加只会命中同一张卡(按正面文字去重),不会在队列里堆副本。
    const existing = await listCramFrontKeys(sessionId, "block");
    const key = frontKey(front);
    if (key && existing.has(key)) {
      return NextResponse.json({ success: true, duplicate: true, sessionTitle: session.title });
    }

    const cardId = await addCramCard({
      sessionId,
      kind: "block",
      front,
      content,
      extra: { source: "coding", problemId },
    });
    return NextResponse.json({ success: true, duplicate: false, cardId, sessionTitle: session.title });
  } catch (err) {
    return fail(err, "coding-to-cram");
  }
}
