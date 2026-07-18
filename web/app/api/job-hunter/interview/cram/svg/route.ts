import { type NextRequest, NextResponse } from "next/server";

import { generateResumeCards } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { extractSvgText } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PASSAGE = 8000;
const MAX_CONTEXT = 4000;

/** 把选中的一大段简历/面试稿 → 若干 SVG 记忆卡片(结构/数字/关键词)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { passage?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const passage = typeof body.passage === "string" ? body.passage.trim().slice(0, MAX_PASSAGE) : "";
  if (passage.length < 8) return bad("请选中一段更长的内容再生成记忆卡片。");
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT) : "";

  try {
    const cards = await generateResumeCards({ passage, context });
    const diagrams = cards.diagrams.map((d) => ({ svg: d.svg, caption: d.caption, text: extractSvgText(d.svg) }));
    return NextResponse.json({ success: true, diagrams });
  } catch (err) {
    return fail(err, "cram-svg");
  }
}
