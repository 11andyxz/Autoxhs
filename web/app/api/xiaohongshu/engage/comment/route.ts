import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError, generateComment } from "@/lib/openai";
import { rateLimit } from "@/lib/rateLimit";
import { CommentValidationError, MAX_COMMENT_CHARS } from "@/lib/xiaohongshu/comment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const DETAIL_TIMEOUT_MS = 40_000;

const GENERIC_ERROR = "评论生成失败，请稍后重试。";
const RATE_LIMIT_ERROR = "当前请求较多，请稍后再试。";

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

type NoteDetail = { title?: string; desc?: string };

/** 读取笔记详情(标题+正文)，供模型生成「相关」评论。失败返回 null（可退回列表标题）。 */
async function fetchNoteDetail(noteId: string, xsecToken: string): Promise<NoteDetail | null> {
  const target =
    `${BASE}/rednote/note?` +
    new URLSearchParams({ note_id: noteId, xsec_token: xsecToken }).toString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; detail?: NoteDetail }
      | null;
    if (!json?.ok || !json.detail) return null;
    return { title: json.detail.title ?? "", desc: json.detail.desc ?? "" };
  } catch {
    return null;
  }
}

/**
 * 「预览」步：为一篇笔记生成一条正向且相关的评论。**不写入任何东西**。
 * 优先读取笔记正文以保证相关性；读不到时退回列表里已有的标题。
 */
export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return NextResponse.json({ success: false, error: RATE_LIMIT_ERROR }, { status: 429 });
  }

  let body: { noteId?: string; xsecToken?: string; title?: string; styleHint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const noteId = (body.noteId ?? "").trim();
  const xsecToken = (body.xsecToken ?? "").trim();
  const fallbackTitle = (body.title ?? "").trim();
  const styleHint = (body.styleHint ?? "").trim();
  if (!noteId || !xsecToken) {
    return NextResponse.json({ success: false, error: "缺少 note_id 或 xsec_token。" }, { status: 400 });
  }

  const detail = await fetchNoteDetail(noteId, xsecToken);
  const title = (detail?.title || fallbackTitle).trim();
  const desc = (detail?.desc || "").trim();
  if (!title && !desc) {
    return NextResponse.json(
      {
        success: false,
        error: "读不到这篇笔记的内容(可能链接过期或被限流)，无法生成相关评论。",
      },
      { status: 502 },
    );
  }

  try {
    const comment = await generateComment({ title, desc }, styleHint);
    return NextResponse.json({ success: true, comment, title }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: mapError(err) },
      { status: statusFor(err) },
    );
  }
}

function mapError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    console.error("[engage/comment] OPENAI_API_KEY 未配置");
    return GENERIC_ERROR;
  }
  if (err instanceof CommentValidationError) {
    return `评论生成结果不合格（应为不超过 ${MAX_COMMENT_CHARS} 字的正向相关评论），请重试。`;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[engage/comment] OpenAI API 错误", { name: err.name, status, code });
    if (status === 429 && code !== "insufficient_quota") return RATE_LIMIT_ERROR;
    return GENERIC_ERROR;
  }
  console.error("[engage/comment] 生成失败", {
    name: (err as { name?: string } | null)?.name ?? "Unknown",
  });
  return GENERIC_ERROR;
}

function statusFor(err: unknown): number {
  if (err instanceof MissingApiKeyError) return 500;
  if (err instanceof CommentValidationError) return 502;
  if (err instanceof OpenAI.APIError) return err.status === 429 ? 429 : 502;
  return 500;
}
