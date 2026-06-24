import { NextResponse, type NextRequest } from "next/server";

import { CTA_LINE } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const AUTO_TIMEOUT_MS = 180_000;

type PublishRequest = {
  title?: string;
  body?: string;
  tags?: string[];
  confirm?: boolean;
  charsPerCard?: number;
  coverImage?: string;
  coverFileId?: string;
};

// 每张图约多少字（分页粒度）。实测一张图约 380~450 字填满，默认偏密以贴近人工长文；夹紧防溢出。
const DEFAULT_CHARS_PER_CARD = 380;
const MIN_CHARS_PER_CARD = 120;
const MAX_CHARS_PER_CARD = 500;

type RednoteAutoResponse = {
  ok?: boolean;
  dry_run?: boolean;
  published?: boolean;
  cards?: unknown;
  file_ids?: unknown;
  publish_file_ids?: unknown;
  note_id?: unknown;
  share_link?: unknown;
  error?: unknown;
  message?: unknown;
  msg?: unknown;
  detail?: unknown;
  code?: string | number;
  response?: unknown;
};

function extractText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["error", "message", "msg", "detail"]) {
      if (key in record) {
        const text = extractText(record[key]);
        if (text) return text;
      }
    }
  }
  return null;
}

function failureDetail(result: RednoteAutoResponse) {
  for (const value of [result.error, result.message, result.msg, result.detail, result.response]) {
    const detail = extractText(value);
    if (detail) return detail;
  }
  return null;
}

function failureCode(result: RednoteAutoResponse) {
  if (result.code !== undefined) return result.code;
  if (result.response && typeof result.response === "object" && "code" in result.response) {
    const code = result.response.code;
    if (typeof code === "string" || typeof code === "number") return code;
  }
  return undefined;
}

/**
 * 仅转发标题、正文、标签到本地 rednote 长文自动发布接口。
 * 图片生成、上传和最终发布 body 的组装均由该服务完成，浏览器不会接触签名或登录态。
 */
export async function POST(req: NextRequest) {
  let request: PublishRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const title = (request.title ?? "").trim();
  const body = (request.body ?? "").trim();
  const tags = (Array.isArray(request.tags) ? request.tags : [])
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!title || !body) {
    return NextResponse.json({ success: false, error: "请先生成并保留标题和正文。" }, { status: 400 });
  }

  const confirm = request.confirm === true;
  const coverFileId = typeof request.coverFileId === "string" ? request.coverFileId.trim() : "";
  // 自传封面优先：用自己的图当第 1 张时，AI 配图(cover_image)就无意义了
  const coverImage =
    !coverFileId && typeof request.coverImage === "string" ? request.coverImage.trim() : "";
  const rawChars = Number(request.charsPerCard);
  const charsPerCard = Number.isFinite(rawChars)
    ? Math.min(MAX_CHARS_PER_CARD, Math.max(MIN_CHARS_PER_CARD, Math.round(rawChars)))
    : DEFAULT_CHARS_PER_CARD;
  const endpoint = new URL("/rednote/creator/long_text/auto", BASE);
  endpoint.searchParams.set("confirm", confirm ? "1" : "0");
  endpoint.searchParams.set("chars_per_card", String(charsPerCard));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTO_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        // desc(caption) = CTA + 标签：把固定 CTA 放在标签前，让 caption 里也带上引导语
        tags: [CTA_LINE, ...tags],
        cover_image: coverImage || undefined,
        cover_fileid: coverFileId || undefined,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let result: RednoteAutoResponse | null = null;
    try {
      result = JSON.parse(raw) as RednoteAutoResponse;
    } catch {
      return NextResponse.json(
        { success: false, error: `长文服务返回非 JSON 响应（HTTP ${response.status}）。` },
        { status: 502 },
      );
    }
    if (!result?.ok) {
      const detail = failureDetail(result ?? {});
      const code = failureCode(result ?? {});
      const codeText = code === undefined ? "" : `（code ${code}）`;
      return NextResponse.json(
        {
          success: false,
          error: detail
            ? `长文生成或发布失败${codeText}：${detail}`
            : `长文生成或发布失败${codeText}（HTTP ${response.status}）。`,
        },
        { status: 502 },
      );
    }
    if (confirm && !result.published) {
      return NextResponse.json(
        { success: false, error: "长文服务未确认发布成功。" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      dryRun: result.dry_run === true || !confirm,
      published: result.published === true,
      cards: typeof result.cards === "number" ? result.cards : 0,
      imageCount: Array.isArray(result.publish_file_ids)
        ? result.publish_file_ids.length
        : Array.isArray(result.file_ids)
          ? result.file_ids.length
          : 0,
      noteId: typeof result.note_id === "string" ? result.note_id : null,
      shareLink: typeof result.share_link === "string" ? result.share_link : null,
    });
  } catch (error) {
    const isAbort = (error as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "长文生成超时（超过 3 分钟），请减少正文长度后重试。"
          : `无法连接本地 rednote 服务(${BASE})，请确认它在运行且浏览器已登录。`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
