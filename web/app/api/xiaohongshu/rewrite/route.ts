import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError, rewriteCopy } from "@/lib/openai";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT_LENGTH = 10_000;

const GENERIC_ERROR = "文案生成失败,请稍后重试。";
const RATE_LIMIT_ERROR = "当前请求较多,请稍后再试。";

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  // 1) 基础限流(服务器端,不依赖前端)
  if (!rateLimit(clientKey(req)).allowed) {
    return NextResponse.json(
      { success: false, error: RATE_LIMIT_ERROR },
      { status: 429 },
    );
  }

  // 2) 解析并校验请求体
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "请输入需要优化的文案。" },
      { status: 400 },
    );
  }

  const rawContent =
    body && typeof (body as { content?: unknown }).content === "string"
      ? (body as { content: string }).content
      : "";
  const content = rawContent.trim();

  if (!content) {
    return NextResponse.json(
      { success: false, error: "请输入需要优化的文案。" },
      { status: 400 },
    );
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      { success: false, error: "输入内容过长,请适当缩短后重试。" },
      { status: 400 },
    );
  }

  // 3) 调用模型(注意:不记录用户完整文案 / 模型完整回答)
  try {
    const data = await rewriteCopy(content);
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
    console.error("[rewrite] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }

  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    // 仅记录类型/状态码,不打印用户文案、模型回答或 API Key
    console.error("[rewrite] OpenAI API 错误", {
      name: err.name,
      status,
      code,
    });
    // 纯限流(非余额不足)给出可重试提示;其余一律通用错误,避免泄露内部信息
    if (status === 429 && code !== "insufficient_quota") {
      return RATE_LIMIT_ERROR;
    }
    return GENERIC_ERROR;
  }

  console.error("[rewrite] 生成失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof OpenAI.APIError) {
    return err.status === 429 ? 429 : 502;
  }
  return 500;
}
