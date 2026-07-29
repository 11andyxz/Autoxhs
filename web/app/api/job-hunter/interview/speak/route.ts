import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getOrSynthesize } from "@/lib/job-hunter/interview/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TEXT = 4000;

/**
 * 面试「读题」:把题干用 OpenAI 合成成自然语音(mp3)返回,替代浏览器机读音。
 * 音频按文本哈希缓存在库里(见 tts.ts),同一句话只合成一次。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return bad("没有要朗读的内容。");

  try {
    const { audio, hash } = await getOrSynthesize(text.slice(0, MAX_TEXT));
    return new NextResponse(new Uint8Array(audio) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        ETag: `"${hash}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err, "speak");
  }
}
