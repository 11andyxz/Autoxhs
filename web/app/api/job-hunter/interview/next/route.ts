import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getNextCard, getSession, getSrCounts } from "@/lib/job-hunter/interview/repo";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 取下一张要复习的卡(间隔重复驱动):优先已到期的复习题,其次新题;都清空则返回 card=null。
 * 只回题干,不回参考答案(答题前对候选人保密)。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  const sessionId = Number(req.nextUrl.searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少 sessionId。");

  try {
    const session = await getSession(sessionId);
    if (!session) return bad("训练会话不存在。", 404);

    const [card, counts] = await Promise.all([getNextCard(sessionId), getSrCounts(sessionId)]);
    if (!card) {
      return NextResponse.json({ success: true, card: null, counts });
    }
    return NextResponse.json({
      success: true,
      counts,
      card: {
        questionId: card.id,
        skill: { id: card.skill_id, name: card.skill, category: card.category },
        type: card.type,
        prompt: card.prompt,
        srState: srState({ reviewed: card.last_reviewed_at != null, interval_days: card.interval_days }),
      },
    });
  } catch (err) {
    return fail(err, "next");
  }
}
