import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { buildOutline } from "@/lib/xiaohongshu/cards/outline";
import { OutlineValidationError } from "@/lib/xiaohongshu/cards/schema";
import { newDeckId, pruneDecks, saveOutline } from "@/lib/xiaohongshu/cards/storage";
import { PALETTE_IDS, STYLE_IDS } from "@/lib/xiaohongshu/cards/tokens";
import {
  MAX_CARDS,
  MIN_CARDS,
  type PaletteId,
  type StyleId,
} from "@/lib/xiaohongshu/cards/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type OutlineRequest = {
  title?: string;
  body?: string;
  tags?: string[];
  style?: string;
  palette?: string;
  cardCount?: number | string;
  watermark?: string;
};

function pickStyle(v: unknown): StyleId | "auto" {
  return typeof v === "string" && (STYLE_IDS as string[]).includes(v) ? (v as StyleId) : "auto";
}

function pickPalette(v: unknown): PaletteId | "auto" {
  return typeof v === "string" && (PALETTE_IDS as string[]).includes(v)
    ? (v as PaletteId)
    : "auto";
}

function pickCount(v: unknown): number | "auto" {
  const n = Number(v);
  if (!Number.isFinite(n)) return "auto";
  const i = Math.round(n);
  return i >= MIN_CARDS && i <= MAX_CARDS ? i : "auto";
}

/**
 * 拆卡：把标题+正文拆成一叠卡的 outline，落盘并回传。
 * 只产出结构化数据，不出图 —— 出图走 /cards/render，中间用户可以先改文案。
 */
export async function POST(req: NextRequest) {
  let request: OutlineRequest;
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

  const tags = (Array.isArray(request.tags) ? request.tags : [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);

  try {
    const outline = await buildOutline({
      title,
      body,
      tags,
      style: pickStyle(request.style),
      palette: pickPalette(request.palette),
      cardCount: pickCount(request.cardCount),
      watermark: typeof request.watermark === "string" ? request.watermark : null,
    });

    const deckId = newDeckId();
    await saveOutline(deckId, outline);
    // 新建一叠就顺手清掉最老的几叠，避免 uploads/ 无限堆积（全仓没有 TTL 清理）
    void pruneDecks().catch(() => {});

    return NextResponse.json({ success: true, deckId, outline });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ success: false, error: "未配置 OPENAI_API_KEY。" }, { status: 500 });
    }
    if (err instanceof OutlineValidationError) {
      return NextResponse.json(
        { success: false, error: "拆卡结果不完整，请重试或缩短正文。" },
        { status: 502 },
      );
    }
    console.error("[cards/outline] 拆卡失败", { name: (err as { name?: string } | null)?.name });
    return NextResponse.json(
      { success: false, error: "拆卡失败，请重试或缩短正文。" },
      { status: 502 },
    );
  }
}
