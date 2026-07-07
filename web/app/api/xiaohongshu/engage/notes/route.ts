import { NextResponse, type NextRequest } from "next/server";

import { MAX_CANDIDATES, MAX_PAGES, type EngageNote } from "@/lib/xiaohongshu/engage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const TIMEOUT_MS = 60_000;

type RawNote = {
  id?: string;
  xsec_token?: string;
  type?: string;
  title?: string;
  user?: string;
  liked?: string;
};

type NotesResponse = { ok?: boolean; notes?: RawNote[]; error?: string; code?: number };

/**
 * 取候选笔记：搜索关键词 或 首页推荐信息流。仅作为本地 rednote 服务的瘦客户端，
 * 不做任何签名/逆向，只转发 + 归一化返回。
 */
export async function POST(req: NextRequest) {
  let body: { mode?: string; keyword?: string; pages?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const mode = body.mode === "homefeed" ? "homefeed" : "search";
  const pages = clampPages(body.pages);

  let target: string;
  if (mode === "homefeed") {
    target = `${BASE}/rednote/homefeed?` + new URLSearchParams({ pages: String(pages) }).toString();
  } else {
    const keyword = (body.keyword ?? "").trim();
    if (!keyword) {
      return NextResponse.json({ success: false, error: "请输入搜索关键词。" }, { status: 400 });
    }
    target =
      `${BASE}/rednote/search?` +
      new URLSearchParams({ keyword, pages: String(pages) }).toString();
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(target, { signal: controller.signal });
    clearTimeout(timer);
    const json = (await res.json().catch(() => null)) as NotesResponse | null;
    if (!json) {
      return NextResponse.json({ success: false, error: "本地服务返回异常。" }, { status: 502 });
    }
    if (!json.ok) {
      return NextResponse.json(
        { success: false, error: friendlyError(json.error) },
        { status: 502 },
      );
    }
    // 归一化 + 过滤无 xsec_token 的项（没令牌就没法读正文/保证相关），并截断到上限
    const seen = new Set<string>();
    const notes: EngageNote[] = [];
    for (const n of json.notes ?? []) {
      const id = (n.id ?? "").trim();
      const xsecToken = (n.xsec_token ?? "").trim();
      if (!id || !xsecToken || seen.has(id)) continue;
      seen.add(id);
      notes.push({
        id,
        xsecToken,
        title: (n.title ?? "").trim(),
        user: (n.user ?? "").trim(),
        liked: (n.liked ?? "").trim(),
        type: (n.type ?? "normal").trim(),
      });
      if (notes.length >= MAX_CANDIDATES) break;
    }
    return NextResponse.json({ success: true, notes });
  } catch (err) {
    const isAbort = (err as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "读取超时，请重试。"
          : `无法连接本地 rednote 服务(${BASE})，请确认它在运行且浏览器已登录。`,
      },
      { status: 502 },
    );
  }
}

function clampPages(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PAGES, Math.max(1, Math.round(n)));
}

function friendlyError(raw?: string): string {
  const e = (raw ?? "").trim();
  if (!e) return "读取失败，请稍后重试。";
  if (/web_session|登录|未登录|mnsv2|签名/i.test(e)) {
    return "读取失败：本地浏览器当前不在已登录的小红书页面。请登录 https://www.xiaohongshu.com/explore 后重试。";
  }
  if (/461|风控|频率|-510|300012/i.test(e)) {
    return "读取被小红书限流(风控)，请稍后再试，或减少翻页数。";
  }
  return `读取失败：${e}`;
}
