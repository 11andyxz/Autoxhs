import { NextResponse, type NextRequest } from "next/server";

import { CTA_LINE } from "@/lib/schema";
import { getDoneNoteIds, markPublished, parseNoteId } from "@/lib/xiaohongshu/notesDb";
import {
  PRIVACY_PUBLIC,
  PRIVACY_SELF,
  buildDesc,
  buildImageNoteBody,
} from "@/lib/xiaohongshu/publishBody";
import { REDNOTE_BASE } from "@/lib/xiaohongshu/rednote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PUBLISH_TIMEOUT_MS = 120_000;
/** 首版自设的保守上限。小红书真实上限未验证（常说 18 张），超了就让用户先删几张。 */
const MAX_IMAGES = 18;

type PublishImagesRequest = {
  title?: string;
  body?: string;
  tags?: string[];
  fileIds?: string[];
  width?: number;
  height?: number;
  privacy?: number;
  confirm?: boolean;
  sourceUrl?: string;
  skipIfPublished?: boolean;
};

type RednoteResp = {
  ok?: boolean;
  dry_run?: boolean;
  published?: boolean;
  note_id?: unknown;
  share_link?: unknown;
  error?: unknown;
  msg?: unknown;
  response?: { code?: unknown; msg?: unknown } | unknown;
};

function failureText(json: RednoteResp | null, status: number): string {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const direct = pick(json?.error) ?? pick(json?.msg);
  const inner =
    json?.response && typeof json.response === "object"
      ? pick((json.response as { msg?: unknown }).msg)
      : null;
  const code =
    json?.response && typeof json.response === "object"
      ? (json.response as { code?: unknown }).code
      : undefined;
  const codeText = code === undefined || code === null ? "" : `（code ${code}）`;
  const detail = direct ?? inner;
  return detail ? `发布失败${codeText}：${detail}` : `发布失败${codeText}（HTTP ${status}）。`;
}

/**
 * 用一组已经上传好的 file_id 发一篇「多图笔记」。
 *
 * 与 /api/xiaohongshu/publish（长文）的区别：那条路只有第 1 张能是自备图，
 * 第 2 张起强制是小红书渲染的文字卡；这条路整叠都是自己的设计卡。
 * body 在 web 侧自组，直接打 rednote 的 /creator/publish（它原样透传）。
 *
 * confirm=false 是纯签名预演，rednote 侧零副作用（对比长文 dry-run 会真渲染真上传）。
 * 预演返回**只回归一化摘要** —— rednote 的 dry-run 原始返回里带着 x-s / x-t 签名头，
 * 绝不能透传给浏览器。
 */
export async function POST(req: NextRequest) {
  let request: PublishImagesRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const title = (request.title ?? "").trim();
  const body = (request.body ?? "").trim();
  if (!title || !body) {
    return NextResponse.json(
      { success: false, error: "请先生成并保留标题和正文。" },
      { status: 400 },
    );
  }

  const fileIds = (Array.isArray(request.fileIds) ? request.fileIds : [])
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  if (fileIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "还没有可发布的图片，请先生成并上传卡片。" },
      { status: 400 },
    );
  }
  if (fileIds.length > MAX_IMAGES) {
    return NextResponse.json(
      { success: false, error: `一篇笔记最多 ${MAX_IMAGES} 张图，当前 ${fileIds.length} 张。` },
      { status: 400 },
    );
  }

  const tags = (Array.isArray(request.tags) ? request.tags : [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);

  // 显式收敛，绝不吃默认值：0=公开 / 1=仅自己可见。
  // rednote 那边 build_publish_body 的 Python 默认形参是 1，漏传会「发出去但没人看得见」。
  const privacy = request.privacy === PRIVACY_SELF ? PRIVACY_SELF : PRIVACY_PUBLIC;
  const confirm = request.confirm === true;
  const sourceNoteId = parseNoteId(request.sourceUrl ?? "");

  // 幂等保护（批量）：真实发布前，若该来源 note_id 已发布过就直接跳过。
  // DB 不可用时降级放行，与长文发布保持一致。
  if (confirm && request.skipIfPublished === true && sourceNoteId) {
    try {
      const done = await getDoneNoteIds([sourceNoteId]);
      if (done.has(sourceNoteId)) {
        return NextResponse.json({
          success: true,
          published: false,
          skipped: true,
          alreadyPublished: true,
          dryRun: false,
          imageCount: 0,
          noteId: null,
          shareLink: null,
        });
      }
    } catch (e) {
      console.error("[publish-images] 发布前去重检查失败(降级放行)", { name: (e as Error)?.name });
    }
  }

  const width = Number.isFinite(Number(request.width)) ? Math.round(Number(request.width)) : 1440;
  const height = Number.isFinite(Number(request.height)) ? Math.round(Number(request.height)) : 1920;
  // caption 有字数上限，超了小红书会从尾部静默截断（标签和 CTA 首当其冲）。
  // 这里按「标签 > CTA > 正文」的优先级自己截，并把截断量回报给前端。
  const descResult = buildDesc(body, tags, { ctaLine: CTA_LINE });
  const desc = descResult.desc;
  const note = buildImageNoteBody({
    title,
    desc,
    images: fileIds.map((fileId) => ({ fileId, width, height })),
    privacy,
  });

  const endpoint = new URL("/rednote/creator/publish", REDNOTE_BASE);
  endpoint.searchParams.set("confirm", confirm ? "1" : "0");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as RednoteResp | null;
    if (!json?.ok) {
      return NextResponse.json(
        { success: false, error: failureText(json, res.status) },
        { status: 502 },
      );
    }

    if (!confirm) {
      // 预演：只回摘要，不回 rednote 原始返回（里面有真实签名头）
      return NextResponse.json({
        success: true,
        dryRun: true,
        published: false,
        imageCount: fileIds.length,
        title,
        descPreview: desc.slice(0, 120),
        descLength: descResult.length,
        descLimit: descResult.limit,
        descTruncated: descResult.truncated,
        descOmitted: descResult.omitted,
        privacy,
        width,
        height,
      });
    }

    if (json.published !== true) {
      return NextResponse.json(
        { success: false, error: "rednote 未确认发布成功。" },
        { status: 502 },
      );
    }

    const noteId = typeof json.note_id === "string" ? json.note_id : null;
    const shareLink = typeof json.share_link === "string" ? json.share_link : null;

    // 公开发布成功后记入去重库（best-effort：失败不影响发布结果）
    let dedupRecorded = false;
    if (sourceNoteId) {
      try {
        await markPublished({
          noteId: sourceNoteId,
          sourceUrl: request.sourceUrl,
          title,
          shareLink: shareLink ?? undefined,
        });
        dedupRecorded = true;
      } catch (e) {
        console.error("[publish-images] 记录去重库失败(忽略)", { name: (e as Error)?.name });
      }
    }

    return NextResponse.json({
      success: true,
      dryRun: false,
      published: true,
      imageCount: fileIds.length,
      noteId,
      shareLink,
      privacy,
      dedupRecorded,
      descLength: descResult.length,
      descTruncated: descResult.truncated,
      descOmitted: descResult.omitted,
    });
  } catch (error) {
    const isAbort = (error as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "发布超时，请重试。"
          : `无法连接本地 rednote 服务(${REDNOTE_BASE})，请确认它在运行且浏览器已登录。`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
