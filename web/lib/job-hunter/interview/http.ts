import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { rateLimit } from "@/lib/rateLimit";

const GENERIC = "操作失败,请稍后重试。";
const RATE = "当前请求较多,请稍后再试。";

export function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

export function tooMany(req: NextRequest): boolean {
  return !rateLimit(clientKey(req)).allowed;
}

/**
 * 独立计数桶。实时功能(听音/转写/推流)必须和「表单式」工具分开算,
 * 否则高频的那一路会把低频但关键的那一路饿死(实测:副屏推流把转写请求 429 掉,
 * 结果面试官的问题永远听不到)。
 */
export function tooManyIn(req: NextRequest, namespace: string, max: number): boolean {
  return !rateLimit(`${namespace}:${clientKey(req)}`, max).allowed;
}

export function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export function rateLimited() {
  return bad(RATE, 429);
}

/** 统一把内部错误映射成中文提示 + 状态码,不泄露 Key / 用户内容 / 模型回答 */
export function fail(err: unknown, tag: string) {
  if (err instanceof MissingApiKeyError) {
    console.error(`[interview:${tag}] OPENAI_API_KEY 未配置`);
    return bad(GENERIC, 500);
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error(`[interview:${tag}] OpenAI API 错误`, { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") return bad(RATE, 429);
    return bad(GENERIC, 502);
  }
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
    console.error(`[interview:${tag}] DB 错误`, { code });
    return bad("数据库暂时不可用,请稍后重试。", 503);
  }
  console.error(`[interview:${tag}] 失败`, { name: (err as { name?: string } | null)?.name ?? "Unknown" });
  return bad(GENERIC, 500);
}
