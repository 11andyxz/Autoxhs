import { type NextRequest, NextResponse } from "next/server";

import { generateConceptImage } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getExplainExtras, getExplainImageB64, saveExplainImage } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 按 imagePlan[ord] 生成一张意象配图并存库(慢,单张)。已生成则直接返回 ready。 */
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
    const existing = await getExplainImageB64(questionId, ord);
    if (existing) return NextResponse.json({ success: true, ord, ready: true });

    const extras = await getExplainExtras(questionId);
    const plan = extras?.imagePlan?.[ord];
    if (!plan) return bad("该配图不存在(请先生成附加料)。", 404);

    const png = await generateConceptImage(plan.prompt);
    await saveExplainImage(questionId, ord, plan.caption, png.toString("base64"));
    return NextResponse.json({ success: true, ord, ready: true });
  } catch (err) {
    return fail(err, "explain-image");
  }
}
