import { NextResponse, type NextRequest } from "next/server";

import { getCommentedNoteIds } from "@/lib/xiaohongshu/engageDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 批量查询哪些 note_id 已评论过(去重库)。供「粘贴链接」模式在客户端解析后标注。
 * DB 不可用时降级返回空(不阻断使用)。
 */
export async function POST(req: NextRequest) {
  let body: { noteIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, commented: [] }, { status: 400 });
  }
  const noteIds = Array.isArray(body.noteIds)
    ? body.noteIds.filter((x): x is string => typeof x === "string")
    : [];
  if (!noteIds.length) return NextResponse.json({ success: true, commented: [] });
  try {
    const set = await getCommentedNoteIds(noteIds);
    return NextResponse.json({ success: true, commented: [...set] });
  } catch (e) {
    console.error("[engage/commented] 去重库查询失败(降级)", { name: (e as Error)?.name });
    return NextResponse.json({ success: true, commented: [] });
  }
}
