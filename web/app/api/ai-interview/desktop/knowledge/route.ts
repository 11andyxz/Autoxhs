import { NextResponse, type NextRequest } from "next/server";

import { parseKnowledgeItems } from "@/lib/aiInterview/desktop";
import { LIMITS, clip } from "@/lib/aiInterview/schema";
import { addKnowledge } from "@/lib/job-hunter/interview/repo";
import { bad, fail, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 面试进行中,把「刚才这道题 + 刚才给的答案」直接丢进知识块(ip_knowledge)。
 *
 * 和会话结束时的批量入库(/desktop/session)是两回事:那个是复盘时补的,这个是当场按一下 ——
 * 答完就知道自己这题没答好,当场标记比会后回忆准得多。
 */
export async function POST(req: NextRequest) {
  if (tooManyIn(req, "aiitv-desktop", 60)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  const company = clip(body.company, LIMITS.company);
  const items = parseKnowledgeItems(body.items);
  if (items.length === 0) return bad("没有可加入的问答。");

  try {
    let added = 0;
    for (const item of items) {
      await addKnowledge({ company, front: item.front, content: item.content });
      added += 1;
    }
    return NextResponse.json({ success: true, added });
  } catch (err) {
    return fail(err, "ai-interview/desktop/knowledge");
  }
}
