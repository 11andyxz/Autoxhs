import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { AlignError, alignResume } from "@/lib/job-hunter/align";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
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

/** 解析规则链接:优先 JSON 数组字段 ruleUrls,兼容按行分隔;去重、去空、限量。 */
function parseRuleUrls(form: FormData): string[] {
  const raw = form.get("ruleUrls");
  let list: string[] = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed.map((x) => String(x));
    } catch {
      list = raw.split(/[\n,]/);
    }
  }
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const file = form.get("resumeFile");
  if (!(file instanceof File) || file.size === 0) {
    return bad("请上传你的简历(.docx 文件)。");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad("简历文件过大,请控制在 5MB 以内。");
  }

  const ruleUrls = parseRuleUrls(form);
  const pastedRaw = form.get("ruleText");
  const pastedRules =
    typeof pastedRaw === "string" ? pastedRaw.slice(0, MAX_PASTED_CHARS) : "";

  if (!ruleUrls.length && !pastedRules.trim()) {
    return bad("请提供至少一个规则来源(Google Docs 链接或粘贴规则文本)。");
  }

  let docxBuf: Buffer;
  try {
    docxBuf = Buffer.from(await file.arrayBuffer());
  } catch {
    return bad("读取简历文件失败,请重试。");
  }

  try {
    const { html, sources } = await alignResume(docxBuf, ruleUrls, pastedRules);
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
