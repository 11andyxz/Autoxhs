import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { addExplainNote, deleteExplainNote } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_NOTE = 8000;

/** 把一条追问答案「添加」为笔记(挂在某题某张图下)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { questionId?: unknown; diagramOrd?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const questionId = Number(body.questionId);
  const diagramOrd = Number(body.diagramOrd);
  if (!Number.isInteger(questionId) || questionId <= 0) return bad("缺少 questionId。");
  if (!Number.isInteger(diagramOrd) || diagramOrd < 0) return bad("缺少 diagramOrd。");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return bad("笔记内容为空。");
  if (text.length > MAX_NOTE) return bad("笔记太长。");

  try {
    const id = await addExplainNote(questionId, diagramOrd, text);
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return fail(err, "explain-note-add");
  }
}

/** 删除一条笔记。 */
export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少笔记 id。");
  try {
    await deleteExplainNote(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "explain-note-del");
  }
}
