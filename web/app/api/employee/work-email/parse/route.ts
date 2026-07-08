import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";
import { MissingApiKeyError } from "@/lib/openai";
import { rateLimit } from "@/lib/rateLimit";
import { ExtractValidationError, extractEmailFromText } from "@/lib/workEmail/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_TEXT_LENGTH = 40_000;

const GENERIC_ERROR = "解析失败，请稍后重试或手动填写。";
const RATE_LIMIT_ERROR = "当前请求较多，请稍后再试。";

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

/**
 * 上传一封邮件的 PDF/DOCX(如 Gmail 导出) → 提取文本 → OpenAI 解析出
 * { subject, toEmail, recipientName, cc, sentAt, body }，供「添加工作记录」自动填表。
 * 不发信、不写库。
 */
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

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return bad("请上传邮件 PDF 或 Word 文件。");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad("文件过大，请控制在 8MB 以内。");
  }

  let text: string;
  try {
    text = await extractTextFromFile(file);
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return bad(GENERIC_ERROR, 500);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
  }

  try {
    const data = await extractEmailFromText(text);
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ success: false, error: mapError(err) }, { status: statusFor(err) });
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[employee/work-email/parse] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof ExtractValidationError) {
    return "没能从文件里解析出邮件内容，请确认是邮件导出的 PDF/Word，或手动填写。";
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[employee/work-email/parse] OpenAI API 错误", { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") return RATE_LIMIT_ERROR;
    return GENERIC_ERROR;
  }
  console.error("[employee/work-email/parse] 解析失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof ExtractValidationError) return 502;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
