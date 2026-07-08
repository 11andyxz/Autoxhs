import { toFile } from "openai";
import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { transcribeAudio } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenAI 转写单文件上限 25MB;面试作答的短录音远小于此。
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// 只允许 ISO-639-1 两位语言码,避免把任意串塞给 API。
const LANG_RE = /^[a-z]{2}$/;

/** 面试「语音作答」:接收浏览器录制的音频,调用 OpenAI 转写成文字返回。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return bad("没有录音数据。");
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return bad("录音过大,请缩短后重试。");
  }

  const langRaw = form.get("language");
  const language = typeof langRaw === "string" && LANG_RE.test(langRaw) ? langRaw : undefined;

  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    // 用原始文件名的扩展名(默认 webm)交给 OpenAI 识别容器格式。
    const name = /\.[a-z0-9]{2,4}$/i.test(audio.name) ? audio.name : "answer.webm";
    const file = await toFile(buf, name, { type: audio.type || "audio/webm" });
    const text = await transcribeAudio(file, language);
    return NextResponse.json({ success: true, text });
  } catch (err) {
    return fail(err, "transcribe");
  }
}
