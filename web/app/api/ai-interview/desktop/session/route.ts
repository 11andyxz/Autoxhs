import { NextResponse, type NextRequest } from "next/server";

import { parseDesktopSessionPayload } from "@/lib/aiInterview/desktop";
import { createSession, endSession, replaceTurns, setSummary } from "@/lib/aiInterview/repo";
import { addKnowledge } from "@/lib/job-hunter/interview/repo";
import { bad, fail, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 桌面端一场面试结束后,把整份记录写进我们自己的库(和浏览器版同两张表:ai_itv_session / ai_itv_turn),
 * 于是历史会话、复盘、导出这些页面不用改一行就能看到桌面端的面试。
 *
 * 一次性整份写:桌面端是「会结束才回传」,不像浏览器版一边听一边 PATCH。
 * 建行 → 覆盖字幕 → 存总结 → 标结束,顺序即幂等(重传就是再建一场,不会污染上一场)。
 *
 * knowledge 里的问答会进「知识块」(ip_knowledge)跟着遗忘曲线复习 —— 面试当场答得磕磕巴巴的题,
 * 正是最该被排进复习队列的题。入库失败不影响会话本身。
 */
export async function POST(req: NextRequest) {
  if (tooManyIn(req, "aiitv-desktop", 60)) return rateLimited();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const payload = parseDesktopSessionPayload(body);
  if (payload.turns.length === 0 && !payload.summary) {
    return bad("这场面试没有任何内容,不必入库。");
  }

  try {
    const id = await createSession({
      title: payload.title,
      mode: payload.mode,
      lang: payload.lang,
      company: payload.company,
      jd: payload.jd,
      notes: payload.notes,
    });

    const turnCount = await replaceTurns(id, payload.turns);
    if (payload.summary) await setSummary(id, payload.summary);
    await endSession(id);

    // 知识块是「顺手做的好事」:失败只报数,不让整场记录跟着回滚。
    let knowledgeAdded = 0;
    for (const item of payload.knowledge) {
      try {
        await addKnowledge({
          company: payload.company,
          front: item.front,
          content: item.content,
        });
        knowledgeAdded += 1;
      } catch (err) {
        console.warn("[ai-interview/desktop/session] 知识块入库失败", {
          code: (err as { code?: string } | null)?.code,
        });
      }
    }

    return NextResponse.json({ success: true, id, turnCount, knowledgeAdded });
  } catch (err) {
    return fail(err, "ai-interview/desktop/session");
  }
}
