/**
 * 从用户粘贴的小红书笔记链接抓取笔记详情(标题/正文/图片)。
 * 与 app/api/xiaohongshu/import 一样,仅作为本地 rednote 服务(端口 3456)的瘦客户端:
 * 本模块不做任何签名/逆向,只解析链接 + 转发 + 归一化返回。
 *
 * 独立于 import 路由实现,是为了让「视频讲解」这条链路自成一套、不牵动既有导入行为。
 */

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

export type XhsNoteDetail = {
  title: string;
  desc: string;
  user: string;
  tags: string[];
  /** "normal"(图文) | "video" */
  type: string;
  /** 公开 CDN 图片直链(可直接下载) */
  images: string[];
};

/** 抓取失败时抛出,路由层据此返回用户可读提示。 */
export class NoteFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteFetchError";
  }
}

/** 把底层 CDP/签名/登录类报错翻译成用户能看懂的提示(与 import 路由一致)。 */
function friendly(raw?: string): string {
  const e = (raw ?? "").trim();
  if (!e) return "读取失败,请检查链接或稍后重试。";
  if (/eval exception|mnsv2|TypeError|未找到小红书标签|签名脚本|签名失败|web_session|登录/i.test(e)) {
    return "读取失败:本地浏览器当前不在已登录的小红书页面。请在该浏览器打开并登录 https://www.xiaohongshu.com/explore 后重试。";
  }
  return `读取失败:${e}`;
}

type RawDetail = {
  title?: string;
  desc?: string;
  user?: string;
  tags?: string[];
  type?: string;
  image_count?: number;
  images?: Array<{ url?: string }>;
};

/** 从完整笔记 URL 抓取详情。链接需带 xsec_token(小红书分享链接自带)。 */
export async function fetchNoteDetail(rawUrl: string): Promise<XhsNoteDetail> {
  const raw = (rawUrl ?? "").trim();
  if (!raw) throw new NoteFetchError("请提供笔记链接。");

  let noteId = "";
  let xsecToken = "";
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    noteId = parts[parts.length - 1] ?? "";
    xsecToken = u.searchParams.get("xsec_token") ?? "";
  } catch {
    throw new NoteFetchError("无法识别链接,请粘贴完整的小红书笔记 URL。");
  }
  if (!noteId || !xsecToken) {
    throw new NoteFetchError("链接中缺少 note_id 或 xsec_token(请复制笔记的完整分享链接)。");
  }

  const target =
    `${BASE}/rednote/note?` +
    new URLSearchParams({ note_id: noteId, xsec_token: xsecToken }).toString();

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw new NoteFetchError("读取超时,请重试。");
    throw new NoteFetchError(
      `无法连接本地 rednote 服务(${BASE}),请确认它在运行且浏览器已登录。`,
    );
  }

  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; detail?: RawDetail; error?: string }
    | null;
  if (!json) throw new NoteFetchError("本地服务返回异常。");
  if (!json.ok || !json.detail) throw new NoteFetchError(friendly(json.error));

  const d = json.detail;
  const images = (d.images ?? [])
    .map((image) => image.url)
    .filter((url): url is string => !!url);

  return {
    title: d.title ?? "",
    desc: d.desc ?? "",
    user: d.user ?? "",
    tags: d.tags ?? [],
    type: d.type ?? "normal",
    images,
  };
}
