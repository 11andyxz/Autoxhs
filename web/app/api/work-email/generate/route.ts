import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";
import { rateLimit } from "@/lib/rateLimit";
import { generateWorkEmail } from "@/lib/workEmail/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_TEXT_LENGTH = 40_000;
const MAX_NAME_LENGTH = 200;
const MAX_WEEK_LENGTH = 100;

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

/** 取上一封邮件文本:优先上传的 PDF/DOCX,其次粘贴的文本 */
async function resolvePriorEmail(form: FormData): Promise<string> {
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      throw new FileParseError("文件过大,请控制在 8MB 以内。");
    }
    const text = await extractTextFromFile(file);
    if (text.length > MAX_TEXT_LENGTH) {
      throw new FileParseError("邮件内容过长,请精简后重试。");
    }
    return text;
  }

  const raw = form.get("priorText");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    throw new FileParseError("请提供上一封工作邮件(上传 PDF / 文本文件,或粘贴文本)。");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new FileParseError("邮件内容过长,请精简后重试。");
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

  let priorEmailText: string;
  try {
    priorEmailText = await resolvePriorEmail(form);
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return bad(GENERIC_ERROR, 500);
  }

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const recipientName = str("recipientName").slice(0, MAX_NAME_LENGTH);
  const targetWeek = str("targetWeek").slice(0, MAX_WEEK_LENGTH);

  try {
    const draft = await generateWorkEmail(priorEmailText, recipientName, targetWeek);
    return NextResponse.json({ success: true, draft }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: mapError(err) },
      { status: statusFor(err) },
    );
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[work-email] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[work-email] OpenAI API 错误", { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") {
      return RATE_LIMIT_ERROR;
    }
    return GENERIC_ERROR;
  }
  console.error("[work-email] 生成失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
