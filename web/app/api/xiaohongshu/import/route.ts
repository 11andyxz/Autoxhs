import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

type NoteDetail = {
  title?: string;
  desc?: string;
  user?: string;
  tags?: string[];
  liked?: string;
  collected?: string;
  comment?: string;
  type?: string;
  image_count?: number;
  images?: Array<{ url?: string }>;
};

/**
 * 把本地服务回传的底层错误翻译成用户能看懂的提示。
 * 当本地 rednote 服务连到的浏览器标签不是已登录的小红书页时,签名脚本(window.mnsv2)缺失,
 * 会冒出 "eval exception / TypeError / mnsv2 未就绪" 之类的原始 CDP 报错——对用户无意义。
 */
function friendlyImportError(raw?: string): string {
  const e = (raw ?? "").trim();
  if (!e) return "读取失败,请检查链接或稍后重试。";
  // 既覆盖底层 CDP/签名报错(eval exception / mnsv2 / TypeError ...),也覆盖小红书 code!=0 的登录类提示
  // (登录已过期 / 无登录信息 等)——它们本质都是"浏览器未在已登录的小红书页面"。
  if (/eval exception|mnsv2|TypeError|未找到小红书标签|签名脚本|签名失败|web_session|登录/i.test(e)) {
    return "读取失败:本地浏览器当前不在已登录的小红书页面。请在该浏览器打开并登录 https://www.xiaohongshu.com/explore 后重试。";
  }
  return `读取失败:${e}`;
}

/**
 * 从用户粘贴的笔记链接读取正文 —— 仅作为本地 rednote 服务(用户自建,基于其登录浏览器)的瘦客户端。
 * 本路由不做任何签名/逆向,只解析链接 + 转发到本地服务 + 回传正文。
 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const raw = (body.url ?? "").trim();
  if (!raw) {
    return NextResponse.json({ success: false, error: "请提供笔记链接。" }, { status: 400 });
  }

  let noteId = "";
  let xsecToken = "";
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    noteId = parts[parts.length - 1] ?? "";
    xsecToken = u.searchParams.get("xsec_token") ?? "";
  } catch {
    return NextResponse.json(
      { success: false, error: "无法识别链接,请粘贴完整的小红书笔记 URL。" },
      { status: 400 },
    );
  }
  if (!noteId || !xsecToken) {
    return NextResponse.json(
      { success: false, error: "链接中缺少 note_id 或 xsec_token。" },
      { status: 400 },
    );
  }

  const target =
    `${BASE}/rednote/note?` +
    new URLSearchParams({ note_id: noteId, xsec_token: xsecToken }).toString();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; detail?: NoteDetail; error?: string; code?: number }
      | null;
    if (!json) {
      return NextResponse.json({ success: false, error: "本地服务返回异常。" }, { status: 502 });
    }
    if (!json.ok || !json.detail) {
      return NextResponse.json(
        { success: false, error: friendlyImportError(json.error) },
        { status: 502 },
      );
    }
    const d = json.detail;
    const images = (d.images ?? []).map((image) => image.url).filter((url): url is string => !!url);
    return NextResponse.json({
      success: true,
      data: {
        title: d.title ?? "",
        desc: d.desc ?? "",
        user: d.user ?? "",
        tags: d.tags ?? [],
        liked: d.liked,
        collected: d.collected,
        comment: d.comment,
        type: d.type ?? "normal",
        imageCount: d.image_count ?? images.length,
        images,
      },
    });
  } catch (err) {
    const isAbort = (err as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "读取超时,请重试。"
          : `无法连接本地 rednote 服务(${BASE}),请确认它在运行且浏览器已登录。`,
      },
      { status: 502 },
    );
  }
}
