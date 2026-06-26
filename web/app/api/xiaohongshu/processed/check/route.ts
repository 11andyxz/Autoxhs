import { NextResponse, type NextRequest } from "next/server";

import { getDoneNoteIds, parseNoteId } from "@/lib/xiaohongshu/notesDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 批量发布预筛：给一组链接，返回每条的 note_id 以及是否「之前已发布过」。
 * 仅查询去重库，不做任何写操作。
 */
export async function POST(req: NextRequest) {
  let body: { urls?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string")
    : [];

  const items = urls.map((url) => ({ url, noteId: parseNoteId(url) }));
  const noteIds = items.map((i) => i.noteId).filter((x): x is string => !!x);

  try {
    const done = await getDoneNoteIds(noteIds);
    return NextResponse.json({
      success: true,
      results: items.map((i) => ({
        url: i.url,
        noteId: i.noteId,
        done: i.noteId ? done.has(i.noteId) : false,
      })),
    });
  } catch (err) {
    console.error("[xiaohongshu/processed/check] 查询去重库失败", {
      name: (err as Error)?.name,
    });
    return NextResponse.json(
      { success: false, error: "无法查询去重库（数据库未配置或连接失败）。" },
      { status: 502 },
    );
  }
}
