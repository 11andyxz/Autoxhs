import type { NextRequest } from "next/server";

import { streamCodingHint } from "@/lib/aiInterview/ai";
import { LIMITS, asLang, clip, parseProfile, parseTurns } from "@/lib/aiInterview/schema";
import { sseResponse } from "@/lib/aiInterview/stream";
import { bad, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 只接受浏览器截屏产出的这两种 data URL */
const IMAGE_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * 截屏解题:把共享屏幕里的一帧(算法题/共享编辑器/白板)交给多模态模型,
 * 流式给出「先复述题目 → 思路 → 代码 → 复杂度 → 边界」。
 */
export async function POST(req: NextRequest) {
  if (tooManyIn(req, "aiitv-live", 600)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image) return bad("没有截屏内容。");
  if (!IMAGE_RE.test(image)) return bad("截屏格式不支持。");
  // base64 比原文件大约 4/3;按字符数粗算即可,只为拦住异常大的图。
  if (image.length > LIMITS.imageBytes * 1.4) return bad("截屏过大,请重试。");

  return sseResponse(
    streamCodingHint(
      {
        image,
        lang: asLang(body.lang),
        question: clip(body.question, LIMITS.question),
        window: parseTurns(body.window, 24),
        profile: parseProfile(body.profile),
      },
      req.signal,
    ),
    "coding",
  );
}
