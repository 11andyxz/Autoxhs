import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { listExplainCards } from "@/lib/job-hunter/interview/repo";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 「讲解复习」面板:列出该会话已生成讲解的题目 + 遗忘曲线状态 + 待复习计数。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const sessionId = Number(req.nextUrl.searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");
  try {
    const rows = await listExplainCards(sessionId);
    const cards = rows.map((r) => ({
      questionId: r.question_id,
      prompt: r.prompt,
      skill: r.skill,
      category: r.category,
      type: r.type,
      lastPct: r.last_pct,
      isDue: r.is_due === 1,
      dueAt: r.due_at,
      reviewed: r.last_reviewed_at != null,
      state: srState({ reviewed: r.last_reviewed_at != null, interval_days: r.interval_days }),
    }));
    const due = cards.filter((c) => c.isDue).length;
    return NextResponse.json({ success: true, cards, counts: { total: cards.length, due } });
  } catch (err) {
    return fail(err, "explain-cards");
  }
}
