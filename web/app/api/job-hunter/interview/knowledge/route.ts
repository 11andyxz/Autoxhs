import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { addKnowledge, deleteKnowledge, listKnowledge } from "@/lib/job-hunter/interview/repo";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_CONTENT = 8000;
const MAX_FRONT = 2000;

/** 知识块列表(跟单词本同框复习用),带 SM-2 状态 + company。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const rows = await listKnowledge();
    const items = rows.map((k) => ({
      id: k.id,
      company: k.company,
      front: k.front ?? "",
      content: k.content,
      svg: k.svg ?? "",
      state: srState({ reviewed: k.last_reviewed_at != null, interval_days: k.interval_days }),
      isDue: k.is_due === 1,
      dueAt: k.due_at,
    }));
    return NextResponse.json({ success: true, items });
  } catch (err) {
    return fail(err, "knowledge-list");
  }
}

/** 加入知识块:{front?(问答的问题), content(正文/选中的块), company?}。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { content?: unknown; front?: unknown; company?: unknown; svg?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const svg = typeof body.svg === "string" ? body.svg.slice(0, 20000) : "";
  // 有 svg(知识卡片)时 content 可为空(用 caption/空);否则必须有正文。
  if (!content && !svg) return bad("没有要加入的内容。");
  if (content.length > MAX_CONTENT) return bad("这块内容太长,请选短一点。");
  const front = typeof body.front === "string" ? body.front.trim().slice(0, MAX_FRONT) : "";
  const company = typeof body.company === "string" ? body.company.slice(0, 120) : "";

  try {
    const id = await addKnowledge({ company, front, content, svg });
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return fail(err, "knowledge-add");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少知识块 id。");
  try {
    await deleteKnowledge(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "knowledge-del");
  }
}
