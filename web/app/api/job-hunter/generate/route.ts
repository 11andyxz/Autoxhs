import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { generateTailoredResume } from "@/lib/job-hunter/generate";
import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_TEXT_LENGTH = 30_000;

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

/** 从 formData 取出某一路输入(文件优先,其次粘贴文本),返回纯文本 */
async function resolveText(
  form: FormData,
  fileField: string,
  textField: string,
  label: string,
): Promise<string> {
  const file = form.get(fileField);
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      throw new FileParseError(`${label}文件过大,请控制在 5MB 以内。`);
    }
    const text = await extractTextFromFile(file);
    if (text.length > MAX_TEXT_LENGTH) {
      throw new FileParseError(`${label}内容过长,请精简后重试。`);
    }
    return text;
  }

  const raw = form.get(textField);
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    throw new FileParseError(`请提供${label}(上传文件或粘贴文本)。`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new FileParseError(`${label}内容过长,请精简后重试。`);
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

  let resumeText: string;
  let jdText: string;
  try {
    resumeText = await resolveText(form, "resumeFile", "resumeText", "简历");
    jdText = await resolveText(form, "jdFile", "jdText", "JD");
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return bad(GENERIC_ERROR, 500);
  }

  const allowEmbellish = form.get("allowEmbellish") === "true";

  try {
    const data = await generateTailoredResume(resumeText, jdText, allowEmbellish);
    return NextResponse.json({ success: true, data }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: mapError(err) },
      { status: statusFor(err) },
    );
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[job-hunter] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[job-hunter] OpenAI API 错误", { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") {
      return RATE_LIMIT_ERROR;
    }
    return GENERIC_ERROR;
  }
  console.error("[job-hunter] 生成失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
