import { toFile } from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { LIMITS } from "@/lib/aiInterview/schema";
import { echoesPrompt, looksLikeHallucination } from "@/lib/aiInterview/transcript";
import { bad, fail, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";
import { transcribeAudio } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 这个功能用的转写模型。默认 gpt-transcribe —— 2026-07-29 用同一段音频实测对比:
 *   模型                    5.35s 语音     3s 近似静音的噪声
 *   whisper-1               ~900ms        每次都吐「Thank you for watching.」
 *   gpt-4o-mini-transcribe  ~600ms        **把 prompt 原样吐回来**(而且把 idempotent 听成 item potent)
 *   gpt-4o-transcribe       ~690ms        也会漏出 prompt 片段
 *   gpt-transcribe          ~840ms        **三次全空 → 零幻觉**,技术术语拼写正确
 * 速度和 whisper-1 基本持平,但噪声上不再凭空造句 —— 实时面试里这一点比几十毫秒重要得多。
 * 可用 AI_INTERVIEW_TRANSCRIBE_MODEL 覆盖。
 */
const TRANSCRIBE_MODEL = process.env.AI_INTERVIEW_TRANSCRIBE_MODEL || "gpt-transcribe";

// 只允许 ISO-639-1 两位语言码,避免把任意串塞给 API。
const LANG_RE = /^[a-z]{2}$/;
/** 太小的片段不可能是人话(VAD 误触发的键盘/咳嗽声),直接不发去转写省钱省时间。 */
const MIN_AUDIO_BYTES = 2_000;

/**
 * 实时转写:页面把 VAD 切出来的一段人声(面试官声道或我的麦克风)发过来,转成文字。
 * hint 传一小段简历/JD 里的专有名词,让 Kafka / Kubernetes 这类词不被听错。
 */
export async function POST(req: NextRequest) {
  // 这是实时链路的命脉:一场面试两个声道会发很多段,不能和别的工具共用计数
  if (tooManyIn(req, "aiitv-live", 600)) return rateLimited();

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
      TRANSCRIBE_MODEL,
    );
    // 安静片段上的字幕垃圾(网址 / "Thanks for watching")当没听到,别进字幕也别去触发回答。
    // 有些转写模型在静音片段上会**把 prompt 原样吐回来**(实测 gpt-4o-mini-transcribe 每次都这样),
    // 那会把简历/JD 里的术语当成面试官说的话写进字幕。这条守卫和模型无关,换模型也不会漏。
    if (echoesPrompt(text, hint) || looksLikeHallucination(text, language)) {
      return NextResponse.json({ success: true, text: "" });
    }
    return NextResponse.json({ success: true, text });
  } catch (err) {
    return fail(err, "ai-interview/transcribe");
  }
}
