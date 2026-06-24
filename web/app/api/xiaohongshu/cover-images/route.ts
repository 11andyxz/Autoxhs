import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
// album_id=7（rednote 默认）实测返回空；4 / 1 才有候选，取两个相册合并去重以增加多样性。
const ALBUMS = [4, 1];

type CoverItem = { image_url?: string } | string;
type RednoteCoverResp = { ok?: boolean; count?: number; cover_images?: CoverItem[]; error?: string };

async function fetchAlbum(summary: string, album: number): Promise<string[]> {
  const url = new URL("/rednote/creator/cover_images", BASE);
  url.searchParams.set("summary", summary);
  url.searchParams.set("album_id", String(album));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = (await res.json().catch(() => null)) as RednoteCoverResp | null;
    return (json?.cover_images ?? [])
      .map((it) => (typeof it === "string" ? it : it?.image_url))
      .filter((u): u is string => !!u);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 AI 配图候选 URL 列表（"AI 换图"用）。转发到本地 rednote 服务的 /creator/cover_images，
 * 合并多个相册并去重。候选基于正文内容生成，正文越完整越可能有候选。
 */
export async function POST(req: NextRequest) {
  let request: { summary?: string };
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const summary = (request.summary ?? "").trim().slice(0, 2000);
  if (!summary) {
    return NextResponse.json({ success: false, error: "缺少正文/摘要。" }, { status: 400 });
  }

  try {
    const results = await Promise.allSettled(ALBUMS.map((a) => fetchAlbum(summary, a)));
    const seen = new Set<string>();
    const images: string[] = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const u of r.value) {
        if (!seen.has(u)) {
          seen.add(u);
          images.push(u);
        }
      }
    }
    return NextResponse.json({ success: true, images });
  } catch {
    return NextResponse.json(
      { success: false, error: `无法连接本地 rednote 服务(${BASE})，请确认它在运行。` },
      { status: 502 },
    );
  }
}
