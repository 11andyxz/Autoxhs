import { NextResponse, type NextRequest } from "next/server";

import { readCardPng, sanitizeDeckId } from "@/lib/xiaohongshu/cards/storage";
import {
  RednoteFailedError,
  RednoteUnreachableError,
  uploadImage,
} from "@/lib/xiaohongshu/rednote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type UploadRequest = {
  deckId?: string;
  /** 第几张（1 起） */
  index?: number;
};

/**
 * 把某一张卡片上传到小红书，换回 file_id。
 *
 * 一次只传一张、由前端串行循环调用 —— 两个原因：
 *  1) rednote 服务全局串行（server.py 每个请求外面套锁），并发打过去只会排队
 *  2) 前端能拿到真实的「第 3/8 张」进度，而不是一个转圈到底的按钮
 */
export async function POST(req: NextRequest) {
  let request: UploadRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const deckId = sanitizeDeckId((request.deckId ?? "").trim());
  const index = Number(request.index) - 1;
  if (!deckId || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ success: false, error: "无效的卡片地址。" }, { status: 400 });
  }

  const png = await readCardPng(deckId, index);
  if (!png) {
    return NextResponse.json(
      { success: false, error: `第 ${index + 1} 张卡片还没渲染，请先生成卡片。` },
      { status: 404 },
    );
  }

  try {
    const fileId = await uploadImage(png, "image/png");
    return NextResponse.json({ success: true, index: index + 1, fileId });
  } catch (err) {
    if (err instanceof RednoteUnreachableError) {
      return NextResponse.json(
        { success: false, error: `${err.message}，请确认它在运行且浏览器已登录。` },
        { status: 502 },
      );
    }
    if (err instanceof RednoteFailedError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 502 });
    }
    console.error("[cards/upload] 上传失败", { name: (err as { name?: string } | null)?.name });
    return NextResponse.json({ success: false, error: "图片上传失败，请重试。" }, { status: 502 });
  }
}
