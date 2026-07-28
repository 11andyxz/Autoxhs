/**
 * 发一篇「多图笔记」的完整动作，收敛成一个函数：
 * 解析话题 → 取自己的 user_id（声明原创）→ 组 caption 与发布 body → 打 rednote。
 *
 * 为什么要抽出来：网页版走 /api/xiaohongshu/publish-images，无人值守的定时发布
 * （lib/xiaohongshu/autoPost）不经 HTTP 直接调 lib。两边如果各写一份，
 * 迟早在「话题双写 / 原创 bizId / caption 截断」这些地方漂开。
 */

import {
  PRIVACY_PUBLIC,
  PRIVACY_SELF,
  buildBusinessBinds,
  buildDesc,
  buildImageNoteBody,
} from "./publishBody";
import {
  REDNOTE_BASE,
  RednoteFailedError,
  fetchSelfUserId,
  resolveTopics,
} from "./rednote";
import { type HashTag, normalizeTagNames } from "./topics";

const PUBLISH_TIMEOUT_MS = 120_000;

export type PublishImageNoteInput = {
  title: string;
  /** 笔记正文（不含话题；话题由本函数按解析结果拼到末尾） */
  body: string;
  /** 标签名（带不带 # 都行）；解析不到同名话题的会被丢弃并在结果里回报 */
  tags: readonly string[];
  fileIds: readonly string[];
  width: number;
  height: number;
  privacy: typeof PRIVACY_PUBLIC | typeof PRIVACY_SELF;
  /** 声明原创（bizId 自动取当前账号 user_id） */
  original: boolean;
  /** false = 只签名预演，不真发 */
  confirm: boolean;
  /** 固定 CTA：caption 超长时会被挪到话题之前保住 */
  ctaLine?: string;
  /**
   * 来源署名行（如 `来源:USCIS -> ...`），排在正文之后、CTA 之前。
   * 必须走这里传，**别自己拼到 body 末尾** —— 那样一超字数就会跟正文一起被截掉。
   */
  sourceLines?: readonly string[];
};

export type PublishImageNoteResult = {
  dryRun: boolean;
  published: boolean;
  noteId: string | null;
  shareLink: string | null;
  imageCount: number;
  desc: {
    text: string;
    length: number;
    limit: number;
    truncated: boolean;
    omitted: number;
    /** 来源署名是否写进去了（额度实在不够时会被舍弃） */
    keptSources: boolean;
  };
  /** 真正写进笔记的话题名 */
  tags: string[];
  /** 没有同名话题、被丢弃的标签名 */
  missingTags: string[];
  original: boolean;
};

type RednoteResp = {
  ok?: boolean;
  published?: boolean;
  note_id?: unknown;
  share_link?: unknown;
  error?: unknown;
  msg?: unknown;
  response?: unknown;
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
 * 发布（或预演）一篇多图笔记。
 *
 * 失败一律抛 RednoteFailedError / RednoteUnreachableError（调用方按自己的方式呈现）。
 * 有一条硬规则：**要了标签却一个都没解析成同名话题时直接中止**，不发。
 * 那多半是登录态失效或话题搜索挂了，而不是这些词恰好都不存在；
 * 发一篇没有任何话题入口的公开笔记等于白发，宁可失败让人重试。
 */
export async function publishImageNote(
  input: PublishImageNoteInput,
): Promise<PublishImageNoteResult> {
  const tagNames = normalizeTagNames(input.tags);

  let hashTags: HashTag[] = [];
  let missingTags: string[] = [];
  if (tagNames.length > 0) {
    const resolved = await resolveTopics(tagNames);
    hashTags = resolved.tags;
    missingTags = resolved.missing;
    if (hashTags.length === 0) {
      throw new RednoteFailedError(
        `${tagNames.length} 个标签一个都没匹配到小红书话题，已中止发布（请确认 rednote 已登录）。`,
      );
    }
  }

  const originalUserId = input.original ? await fetchSelfUserId() : "";

  const descResult = buildDesc(input.body, hashTags, {
    ctaLine: input.ctaLine,
    sourceLines: input.sourceLines,
  });
  // hash_tag 必须与 desc 里实际写出的话题严格对应（顺序、个数都要一致）
  const publishedTags = hashTags.slice(0, descResult.keptTags);
  const note = buildImageNoteBody({
    title: input.title,
    desc: descResult.desc,
    images: input.fileIds.map((fileId) => ({
      fileId,
      width: input.width,
      height: input.height,
    })),
    privacy: input.privacy,
    hashTags: publishedTags,
    businessBinds: buildBusinessBinds({ originalUserId }),
  });

  const shared = {
    imageCount: input.fileIds.length,
    desc: {
      text: descResult.desc,
      length: descResult.length,
      limit: descResult.limit,
      truncated: descResult.truncated,
      omitted: descResult.omitted,
      keptSources: descResult.keptSources,
    },
    tags: publishedTags.map((t) => t.name),
    missingTags,
    original: Boolean(originalUserId),
  };

  const endpoint = new URL("/rednote/creator/publish", REDNOTE_BASE);
  endpoint.searchParams.set("confirm", input.confirm ? "1" : "0");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  let res: Response;
  let json: RednoteResp | null;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
      signal: controller.signal,
    });
    json = (await res.json().catch(() => null)) as RednoteResp | null;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new RednoteFailedError("发布超时，请重试。");
    }
    // 网络层中断：rednote 可能已经发出去了，结果未知 —— 由调用方决定要不要重试
    throw new RednoteFailedError(
      `无法连接本地 rednote 服务(${REDNOTE_BASE})，请确认它在运行且浏览器已登录。`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!json?.ok) {
    throw new RednoteFailedError(failureText(json, res.status));
  }

  if (!input.confirm) {
    return { ...shared, dryRun: true, published: false, noteId: null, shareLink: null };
  }
  if (json.published !== true) {
    throw new RednoteFailedError("rednote 未确认发布成功。");
  }

  return {
    ...shared,
    dryRun: false,
    published: true,
    noteId: typeof json.note_id === "string" ? json.note_id : null,
    shareLink: typeof json.share_link === "string" ? json.share_link : null,
  };
}
