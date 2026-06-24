import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 上传用户自己的封面图（作为发布的第 1 张图）。请求体 = 图片原始字节，
 * Content-Type 为图片 mime。转发到本地 rednote 服务的 /creator/upload，返回 file_id。
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    return NextResponse.json({ success: false, error: "请上传图片文件。" }, { status: 400 });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) {
    return NextResponse.json({ success: false, error: "图片为空。" }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) {
    return NextResponse.json({ success: false, error: "图片过大（上限 10MB）。" }, { status: 400 });
  }

  const endpoint = new URL("/rednote/creator/upload", BASE);
  endpoint.searchParams.set("content_type", contentType);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(buf),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; file_id?: string; error?: string }
      | null;
    if (!json?.ok || !json.file_id) {
      return NextResponse.json(
        { success: false, error: json?.error ? `封面上传失败：${json.error}` : "封面上传失败。" },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, fileId: json.file_id });
  } catch (error) {
    const isAbort = (error as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "封面上传超时，请重试。"
          : `无法连接本地 rednote 服务(${BASE})，请确认它在运行。`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
