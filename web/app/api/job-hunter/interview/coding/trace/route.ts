import { type NextRequest, NextResponse } from "next/server";

import { traceCodingSolution } from "@/lib/job-hunter/interview/ai";
import { getCodingProblem, getCodingTrace, saveCodingTrace } from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { normalizeCodingTrace } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 「断点」:把这道题的参考代码按求值顺序拆成一步步(每步的返回类型 + 示例值)。
 * 拆解结果按题 + 参考代码哈希缓存,同一道题只生成一次;改了代码或点「重新拆」才重算。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { problemId?: unknown; regenerate?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const problemId = Number(body.problemId);
  if (!Number.isInteger(problemId) || problemId <= 0) return bad("缺少题目 id。");

  try {
    const problem = await getCodingProblem(problemId);
    if (!problem) return bad("题目不存在。", 404);

    if (body.regenerate !== true) {
      const cached = await getCodingTrace(problemId, problem.solution);
      if (cached) {
        // 缓存里的数据也过一遍 normalize:老格式/脏数据不至于把页面搞崩。
        try {
          return NextResponse.json({ success: true, trace: normalizeCodingTrace(cached), cached: true });
        } catch {
          /* 缓存不可用 → 往下重新生成 */
        }
      }
    }

    const trace = await traceCodingSolution({
      title: problem.title,
      prompt: problem.prompt,
      setup: problem.setup ?? "",
      lang: problem.lang,
      solution: problem.solution,
    });
    await saveCodingTrace(problemId, problem.solution, trace);
    return NextResponse.json({ success: true, trace, cached: false });
  } catch (err) {
    return fail(err, "coding-trace");
  }
}
