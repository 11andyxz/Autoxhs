import { type NextRequest, NextResponse } from "next/server";

import { addCramCardsBulk, getCramSession } from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS = 5000;

/** 批量导入题库:{sessionId, items:[{front(问题), content(答案)}]} → 建成问答闪卡(kind='block')。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { sessionId?: unknown; items?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少简历 id。");
  if (!Array.isArray(body.items) || !body.items.length) return bad("没有要导入的题目。");
  if (body.items.length > MAX_ITEMS) return bad("一次导入的题目太多了，请分批。");

  const items = (body.items as unknown[])
    .filter((it): it is { front?: unknown; content?: unknown } => !!it && typeof it === "object")
    .map((it) => ({
      kind: "block" as const,
      front: typeof it.front === "string" ? it.front.trim() : "",
      content: typeof it.content === "string" ? it.content.trim() : "",
    }))
    .filter((it) => it.front || it.content);
  if (!items.length) return bad("没有有效的题目。");

  try {
    const s = await getCramSession(sessionId);
    if (!s) return bad("这份简历不存在。", 404);
    const count = await addCramCardsBulk(sessionId, items);
    return NextResponse.json({ success: true, count });
  } catch (err) {
    return fail(err, "cram-import");
  }
}
