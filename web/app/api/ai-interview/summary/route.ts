import { NextResponse, type NextRequest } from "next/server";

import { summarizeSession } from "@/lib/aiInterview/ai";
import { getSession, setSummary } from "@/lib/aiInterview/repo";
import { LIMITS, clip, parseTurns } from "@/lib/aiInterview/schema";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 会后复盘:按整场记录生成「问了什么 / 答得怎样 / 要补什么 / 下轮可能问什么」。
 * 传 id 就从库里取记录并把总结写回该会话;没有 id(库不可用时的退路)则用请求里带的字幕。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  const id = Number(body.id);
  const hasId = Number.isInteger(id) && id > 0;

  try {
    let turns = parseTurns(body.turns, 2_000);
    let jd = clip(body.jd, LIMITS.jd);
    let company = clip(body.company, LIMITS.company);

    if (hasId) {
      const session = await getSession(id);
      if (!session) return bad("会话不存在。", 404);
      if (session.turns.length) turns = session.turns;
      jd = session.jd || jd;
      company = session.company || company;
    }

    if (turns.length < 2) return bad("记录太少,还不值得复盘。");

    const summary = await summarizeSession({ turns, profile: { jd, company } });
    if (!summary) return bad("总结生成失败,请重试。", 502);
    if (hasId) await setSummary(id, summary);
    return NextResponse.json({ success: true, summary });
  } catch (err) {
    return fail(err, "ai-interview/summary");
  }
}
