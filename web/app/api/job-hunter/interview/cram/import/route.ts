import { type NextRequest, NextResponse } from "next/server";

import { addCramCardsBulk, getCramSession, listCramFrontKeys } from "@/lib/job-hunter/interview/cram";
import { frontKey } from "@/lib/job-hunter/interview/frontKey";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS = 5000;

/**
 * 批量导入题库:{sessionId, items:[{front(问题), content(答案)}]} → 建成问答闪卡(kind='block')。
 * 去重:同一份简历里、问题文本(空白/大小写不敏感)已经有卡的直接跳过,批次内部重复也只留第一条。
 * 所以同一份 Excel 反复导、或先导 5★ 再导全部,都只会补进新题,已复习的进度不会被复制一份。
 */
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
      source: "import" as const, // 复习时能按「题库导入」单独挑出来
      front: typeof it.front === "string" ? it.front.trim() : "",
      content: typeof it.content === "string" ? it.content.trim() : "",
    }))
    .filter((it) => it.front || it.content);
  if (!items.length) return bad("没有有效的题目。");

  try {
    const s = await getCramSession(sessionId);
    if (!s) return bad("这份简历不存在。", 404);

    const existing = await listCramFrontKeys(sessionId, "block");
    const batch = new Set<string>();
    const fresh: typeof items = [];
    let skipped = 0;
    for (const it of items) {
      const key = frontKey(it.front);
      if (!key) {
        fresh.push(it); // 没有问题文本的(只有答案)不参与去重,照常导入
        continue;
      }
      if (existing.has(key) || batch.has(key)) {
        skipped++;
        continue;
      }
      batch.add(key);
      fresh.push(it);
    }

    const count = fresh.length ? await addCramCardsBulk(sessionId, fresh) : 0;
    return NextResponse.json({ success: true, count, skipped, total: items.length });
  } catch (err) {
    return fail(err, "cram-import");
  }
}
