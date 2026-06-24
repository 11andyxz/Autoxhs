import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError, generateCoverImage } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const MAX_PROMPT = 500;

/**
 * GPT 生图封面：根据输入主题生成竖版小红书封面（默认带 @北美熊哥聊求职 水印），
 * 上传到本地 rednote 服务得到 file_id（可直接作为发布第 1 张封面），并回传预览 dataUrl。
 */
export async function POST(req: NextRequest) {
  let request: { prompt?: string };
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const prompt = (request.prompt ?? "").trim().slice(0, MAX_PROMPT);
  if (!prompt) {
    return NextResponse.json({ success: false, error: "请输入封面内容/主题。" }, { status: 400 });
  }

  // 1) 生图
  let png: Buffer;
  try {
    png = await generateCoverImage(prompt);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ success: false, error: "未配置 OPENAI_API_KEY。" }, { status: 500 });
    }
    console.error("[generate-cover] 生图失败", { name: (err as { name?: string } | null)?.name });
    return NextResponse.json(
      { success: false, error: "封面生成失败，请重试或换个描述。" },
      { status: 502 },
    );
  }

  // 2) 上传到 rednote → file_id（用作发布第 1 张封面）
  const endpoint = new URL("/rednote/creator/upload", BASE);
  endpoint.searchParams.set("content_type", "image/png");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(png),
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
    return NextResponse.json({
      success: true,
      fileId: json.file_id,
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    });
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
