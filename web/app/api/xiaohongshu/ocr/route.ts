import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError, extractTextFromImages } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { imageUrls?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    : [];
  if (!imageUrls.length) {
    return NextResponse.json({ success: false, error: "没有可识别的图片。" }, { status: 400 });
  }

  try {
    const text = await extractTextFromImages(imageUrls);
    if (!text) {
      return NextResponse.json({ success: false, error: "未能从图片中识别到文字。" }, { status: 200 });
    }
    return NextResponse.json({ success: true, text });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error("[xiaohongshu/ocr] OPENAI_API_KEY 未配置");
      return NextResponse.json({ success: false, error: "识别失败,请稍后重试。" }, { status: 500 });
    }
    console.error("[xiaohongshu/ocr] 失败", { name: (err as Error)?.name });
    return NextResponse.json(
      { success: false, error: "图片文字识别失败,请稍后重试。" },
      { status: 502 },
    );
  }
}
