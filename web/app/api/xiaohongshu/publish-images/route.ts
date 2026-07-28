import { NextResponse, type NextRequest } from "next/server";

import { CTA_LINE } from "@/lib/schema";
import { getDoneNoteIds, markPublished, parseNoteId } from "@/lib/xiaohongshu/notesDb";
import { PRIVACY_PUBLIC, PRIVACY_SELF } from "@/lib/xiaohongshu/publishBody";
import { publishImageNote } from "@/lib/xiaohongshu/publishNote";
import { REDNOTE_BASE, RednoteFailedError, RednoteUnreachableError } from "@/lib/xiaohongshu/rednote";
import { normalizeTagNames } from "@/lib/xiaohongshu/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  /** 声明原创。不传按 true —— 这里发的都是自己改写的内容，默认声明。 */
  original?: boolean;
};

/**
 * 用一组已经上传好的 file_id 发一篇「多图笔记」。
 *
 * 与 /api/xiaohongshu/publish（长文）的区别：那条路只有第 1 张能是自备图，
 * 第 2 张起强制是小红书渲染的文字卡；这条路整叠都是自己的设计卡。
 *
 * 组 body 与真正的发布动作在 lib/xiaohongshu/publishNote 里（无人值守的定时发布也用同一份）；
 * 这里只管 HTTP 层：入参校验、去重库、响应裁剪。
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

  const tagNames = normalizeTagNames(
    (Array.isArray(request.tags) ? request.tags : []).filter((t): t is string => typeof t === "string"),
  );
  const original = request.original !== false;

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

  let result: Awaited<ReturnType<typeof publishImageNote>>;
  try {
    result = await publishImageNote({
      title,
      body,
      tags: tagNames,
      fileIds,
      width,
      height,
      privacy,
      original,
      confirm,
      ctaLine: CTA_LINE,
    });
  } catch (error) {
    const message =
      error instanceof RednoteFailedError
        ? error.message
        : error instanceof RednoteUnreachableError
          ? `无法连接本地 rednote 服务(${REDNOTE_BASE})，请确认它在运行且浏览器已登录。`
          : "发布失败，请重试。";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }

  const common = {
    success: true as const,
    imageCount: result.imageCount,
    privacy,
    descLength: result.desc.length,
    descTruncated: result.desc.truncated,
    descOmitted: result.desc.omitted,
    tags: result.tags,
    missingTags: result.missingTags,
    original: result.original,
  };

  if (!confirm) {
    // 预演：只回摘要，不回 rednote 原始返回（里面有真实签名头）
    return NextResponse.json({
      ...common,
      dryRun: true,
      published: false,
      title,
      descPreview: result.desc.text.slice(0, 120),
      descLimit: result.desc.limit,
      width,
      height,
    });
  }

  // 公开发布成功后记入去重库（best-effort：失败不影响发布结果）
  let dedupRecorded = false;
  if (sourceNoteId) {
    try {
      await markPublished({
        noteId: sourceNoteId,
        sourceUrl: request.sourceUrl,
        title,
        shareLink: result.shareLink ?? undefined,
      });
      dedupRecorded = true;
    } catch (e) {
      console.error("[publish-images] 记录去重库失败(忽略)", { name: (e as Error)?.name });
    }
  }

  return NextResponse.json({
    ...common,
    dryRun: false,
    published: true,
    noteId: result.noteId,
    shareLink: result.shareLink,
    dedupRecorded,
  });
}
