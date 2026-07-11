import { type NextRequest, NextResponse } from "next/server";

import { generateConceptImage } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getExplainExtras, getExplainImageB64, saveExplainImage } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 同一 (questionId,ord) 的在途生成去重(同实例):避免快速切换/重开时对同一张图重复烧钱。
// 挂在 globalThis 防 dev HMR 重建模块丢状态。
const g = globalThis as unknown as { __ipImgInflight?: Map<string, Promise<boolean>> };
const inflight = (g.__ipImgInflight ??= new Map<string, Promise<boolean>>());

/** 按 imagePlan[ord] 生成一张意象配图并存库(慢,单张)。已生成/在途则不重复烧钱。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; ord?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  const ord = Number(body.ord);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  if (!Number.isInteger(ord) || ord < 0) return bad("缺少 ord。");

  try {
    if (await getExplainImageB64(questionId, ord)) {
      return NextResponse.json({ success: true, ord, ready: true });
    }

    const key = `${questionId}:${ord}`;
    // 已有同 key 在途:等它,不再发起第二次生成(去重防双计费)。
    const pending = inflight.get(key);
    if (pending) {
      await pending;
      const ready = (await getExplainImageB64(questionId, ord)) != null;
      return NextResponse.json({ success: true, ord, ready });
    }

    // 把「读计划 + 生成 + 存」整体塞进 run,并在同一同步块里 set(check→set 之间无 await),
    // 这样两个并发请求里只有一个真正生成(彻底去重、防双计费)。
    const run = (async (): Promise<boolean> => {
      const extras = await getExplainExtras(questionId);
      const plan = extras?.imagePlan?.[ord];
      if (!plan) return false; // 附加料还没生成/该 ord 不存在:交给前端标失败
      const png = await generateConceptImage(plan.prompt);
      // 版本守卫:计划若在生成期间被重生/清空,这张过期图不写回。
      return saveExplainImage(questionId, ord, plan.caption, png.toString("base64"), extras.version);
    })();
    inflight.set(key, run);
    let wrote = false;
    try {
      wrote = await run;
    } finally {
      inflight.delete(key);
    }
    return NextResponse.json({ success: true, ord, ready: wrote });
  } catch (err) {
    return fail(err, "explain-image");
  }
}
