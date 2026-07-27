import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { htmlToText, splitHtmlDoc } from "@/lib/job-hunter/align";
import { generateTailoredResume } from "@/lib/job-hunter/generate";
import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";
import { TailorFormatError, tailorResumeHtmlToJd } from "@/lib/job-hunter/tailorFormat";
import { tailorModeFromForm } from "@/lib/job-hunter/tailorMode";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 保留格式的整份改写较慢(约 3~4 分钟),与「按规则对齐改写」一致给足 300s。
export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_LENGTH = 30_000;
// 简历已在客户端转成 HTML(docx-preview 高保真渲染,含内联样式,体积偏大),给足上限。
const MAX_RESUME_HTML_CHARS = 3 * 1024 * 1024; // 3MB

const GENERIC_ERROR = "生成失败,请稍后重试。";
const RATE_LIMIT_ERROR = "当前请求较多,请稍后再试。";

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 取出 JD 文本(文件优先,其次粘贴文本)。 */
async function resolveJdText(form: FormData): Promise<string> {
  const file = form.get("jdFile");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      throw new FileParseError("JD 文件过大,请控制在 5MB 以内。");
    }
    const text = await extractTextFromFile(file);
    if (text.length > MAX_TEXT_LENGTH) {
      throw new FileParseError("JD 内容过长,请精简后重试。");
    }
    return text;
  }
  const raw = form.get("jdText");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new FileParseError("请提供目标 JD(上传文件或粘贴文本)。");
  if (text.length > MAX_TEXT_LENGTH) {
    throw new FileParseError("JD 内容过长,请精简后重试。");
  }
  return text;
}

export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return bad(RATE_LIMIT_ERROR, 429);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const resumeHtml = typeof form.get("resumeHtml") === "string" ? String(form.get("resumeHtml")) : "";
  if (!resumeHtml.trim()) {
    return bad("请先上传简历并等待转换完成(仅 .docx 支持保留原格式)。");
  }
  if (resumeHtml.length > MAX_RESUME_HTML_CHARS) {
    return bad("简历内容过大,请精简后重试。");
  }

  let jdText: string;
  try {
    jdText = await resolveJdText(form);
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return bad(GENERIC_ERROR, 500);
  }

  const mode = tailorModeFromForm(form);
  // 从原格式 HTML 里取纯文本,喂给「匹配分析 / 求职信」链路(它不需要格式,只要事实)。
  const resumeText = htmlToText(splitHtmlDoc(resumeHtml).body).slice(0, MAX_TEXT_LENGTH);
  if (!resumeText.trim()) {
    return bad("简历内容为空,请重新上传。");
  }

  try {
    // 两条链路并行:结构化「匹配分析 + 求职信」与「保留原格式的定制简历 HTML」。
    const [data, tailoredHtml] = await Promise.all([
      generateTailoredResume(resumeText, jdText, mode),
      tailorResumeHtmlToJd(resumeHtml, jdText, mode),
    ]);
    return NextResponse.json(
      { success: true, data, resumeHtml: tailoredHtml, jdText },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof TailorFormatError) return bad(err.message);
    return NextResponse.json(
      { success: false, error: mapError(err) },
      { status: statusFor(err) },
    );
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[job-hunter/generate-preserve] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[job-hunter/generate-preserve] OpenAI API 错误", {
      name: err.name,
      status,
      code,
    });
    if (status === 429 && code !== "insufficient_quota") return RATE_LIMIT_ERROR;
    return GENERIC_ERROR;
  }
  console.error("[job-hunter/generate-preserve] 生成失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
