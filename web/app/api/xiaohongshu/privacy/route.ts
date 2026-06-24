import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

type PrivacyRequest = {
  noteId?: string;
  privacy?: number; // 0=公开, 1=仅自己可见
};

type RednotePrivacyResponse = {
  ok?: boolean;
  privacy_label?: string;
  code?: number;
  msg?: string;
  error?: string;
};

/**
 * 设置已发布笔记的可见性。仅转发 note_id + privacy 到本地 rednote 服务
 * （POST /rednote/creator/note/privacy?note_id=..&privacy=0|1）。这是可逆的真实写操作。
 */
export async function POST(req: NextRequest) {
  let request: PrivacyRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const noteId = (request.noteId ?? "").trim();
  const privacy = request.privacy;
  if (!noteId || (privacy !== 0 && privacy !== 1)) {
    return NextResponse.json(
      { success: false, error: "缺少 noteId 或 privacy（0=公开，1=仅自己可见）。" },
      { status: 400 },
    );
  }

  const endpoint = new URL("/rednote/creator/note/privacy", BASE);
  endpoint.searchParams.set("note_id", noteId);
  endpoint.searchParams.set("privacy", String(privacy));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(endpoint, { method: "POST", signal: controller.signal });
    const result = (await res.json().catch(() => null)) as RednotePrivacyResponse | null;
    if (!result?.ok) {
      const detail =
        result?.error ||
        result?.msg ||
        (result?.code !== undefined ? `code ${result.code}` : "");
      return NextResponse.json(
        { success: false, error: detail ? `设置可见性失败：${detail}` : "设置可见性失败。" },
        { status: 502 },
      );
    }
    return NextResponse.json({
      success: true,
      privacy,
      label: result.privacy_label ?? (privacy === 1 ? "仅自己可见" : "公开"),
    });
  } catch (error) {
    const isAbort = (error as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "设置可见性超时，请重试。"
          : `无法连接本地 rednote 服务(${BASE})，请确认它在运行。`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
