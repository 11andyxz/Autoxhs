import { toFile } from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { LIMITS } from "@/lib/aiInterview/schema";
import { looksLikeHallucination } from "@/lib/aiInterview/transcript";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { transcribeAudio } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 只允许 ISO-639-1 两位语言码,避免把任意串塞给 API。
const LANG_RE = /^[a-z]{2}$/;
/** 太小的片段不可能是人话(VAD 误触发的键盘/咳嗽声),直接不发去转写省钱省时间。 */
const MIN_AUDIO_BYTES = 2_000;

/**
 * 实时转写:页面把 VAD 切出来的一段人声(面试官声道或我的麦克风)发过来,转成文字。
 * hint 传一小段简历/JD 里的专有名词,让 Kafka / Kubernetes 这类词不被听错。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return bad("没有录音数据。");
  if (audio.size > LIMITS.audioBytes) return bad("音频片段过大。");
  if (audio.size < MIN_AUDIO_BYTES) {
    // 不算失败:页面照常继续听下一段。
    return NextResponse.json({ success: true, text: "" });
  }

  const langRaw = form.get("language");
  const language = typeof langRaw === "string" && LANG_RE.test(langRaw) ? langRaw : undefined;
  const hintRaw = form.get("hint");
  const hint = typeof hintRaw === "string" ? hintRaw : undefined;

  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    const name = /\.[a-z0-9]{2,4}$/i.test(audio.name) ? audio.name : "chunk.webm";
    const file = await toFile(buf, name, { type: audio.type || "audio/webm" });
    // 这一步是整条链路里最占时间的一环(一句话约 1~2 秒)。想更快可以把
    // AI_INTERVIEW_TRANSCRIBE_MODEL 设成更快的转写模型(如 gpt-4o-mini-transcribe),
    // 只影响这个功能,不动「面试复习」用的那套。
    const text = await transcribeAudio(
      file,
      language,
      hint,
      process.env.AI_INTERVIEW_TRANSCRIBE_MODEL,
    );
    // 安静片段上的字幕垃圾(网址 / "Thanks for watching")当没听到,别进字幕也别去触发回答。
    if (looksLikeHallucination(text)) {
      return NextResponse.json({ success: true, text: "" });
    }
    return NextResponse.json({ success: true, text });
  } catch (err) {
    return fail(err, "ai-interview/transcribe");
  }
}
