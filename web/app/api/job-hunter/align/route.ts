import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { AlignError, alignResumeHtml } from "@/lib/job-hunter/align";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 简历已在客户端转成 HTML(docx-preview 高保真渲染,含内联样式,体积偏大),给足上限。
const MAX_RESUME_HTML_CHARS = 3 * 1024 * 1024; // 3MB
const MAX_URLS = 8;
const MAX_PASTED_CHARS = 20_000;

const GENERIC_ERROR = "改写失败,请稍后重试。";
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

/** 规范化规则链接:去重、去空、限量。 */
function normalizeRuleUrls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of list) {
    const s = u.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return bad(RATE_LIMIT_ERROR, 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const resumeHtml = typeof b.resumeHtml === "string" ? b.resumeHtml : "";
  if (!resumeHtml.trim()) {
    return bad("请先上传简历并等待转换完成(.docx 或 .html)。");
  }
  if (resumeHtml.length > MAX_RESUME_HTML_CHARS) {
    return bad("简历内容过大,请精简后重试。");
  }

  // 可选:模板 HTML(传了就用模板的格式,否则保留简历自身格式)
  const templateHtml = typeof b.templateHtml === "string" ? b.templateHtml : "";
  if (templateHtml.length > MAX_RESUME_HTML_CHARS) {
    return bad("模板内容过大,请精简后重试。");
  }

  const ruleUrls = normalizeRuleUrls(b.ruleUrls);
  const pastedRules =
    typeof b.ruleText === "string" ? b.ruleText.slice(0, MAX_PASTED_CHARS) : "";

  if (!ruleUrls.length && !pastedRules.trim()) {
    return bad("请提供至少一个规则来源(Google Docs 链接或粘贴规则文本)。");
  }

  try {
    const { html, sources } = await alignResumeHtml(
      resumeHtml,
      ruleUrls,
      pastedRules,
      templateHtml || undefined,
    );
    return NextResponse.json({ success: true, html, sources }, { status: 200 });
  } catch (err) {
    if (err instanceof AlignError) {
      // 附带各规则来源状态,便于前端提示「哪个链接没读到、为什么」
      return NextResponse.json(
        { success: false, error: err.message, sources: err.sources },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { success: false, error: mapError(err) },
      { status: statusFor(err) },
    );
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[job-hunter/align] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[job-hunter/align] OpenAI API 错误", { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") return RATE_LIMIT_ERROR;
    return GENERIC_ERROR;
  }
  console.error("[job-hunter/align] 改写失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
