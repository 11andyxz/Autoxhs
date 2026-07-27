import { NextResponse, type NextRequest } from "next/server";

import { ChromeNotFoundError } from "@/lib/pdfTools/wordToPdf";
import { FontsMissingError } from "@/lib/xiaohongshu/cards/fonts";
import { OUTPUT_SIZE, renderCards } from "@/lib/xiaohongshu/cards/render";
import {
  readOutline,
  sanitizeDeckId,
  saveCardPng,
  saveOutline,
} from "@/lib/xiaohongshu/cards/storage";
import type { CardOutline } from "@/lib/xiaohongshu/cards/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RenderRequest = {
  deckId?: string;
  /** 用户改过文案/换过风格时带上新的 outline，服务端先落盘再渲染 */
  outline?: CardOutline;
  /** 只重渲第 n 张（1 起，跟 UI 上的编号一致） */
  only?: number;
};

/**
 * 渲染卡片为 PNG 并落盘。图片不走响应体（8~10 张几十 MB），
 * 前端拿 deckId 去 /cards/file/<deckId>/<n> 逐张取。
 */
export async function POST(req: NextRequest) {
  let request: RenderRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const deckId = sanitizeDeckId((request.deckId ?? "").trim());
  if (!deckId) {
    return NextResponse.json({ success: false, error: "无效的卡片批次 ID。" }, { status: 400 });
  }

  // 带了 outline 就以它为准（用户刚编辑过），否则读盘上一次的
  let outline: CardOutline | null = request.outline ?? null;
  if (outline) {
    await saveOutline(deckId, outline);
  } else {
    outline = await readOutline(deckId);
  }
  if (!outline || !Array.isArray(outline.cards) || outline.cards.length === 0) {
    return NextResponse.json(
      { success: false, error: "找不到这批卡片，请重新拆卡。" },
      { status: 404 },
    );
  }

  let only: number | undefined;
  if (request.only !== undefined) {
    const n = Number(request.only);
    if (!Number.isInteger(n) || n < 1 || n > outline.cards.length) {
      return NextResponse.json({ success: false, error: "卡片序号超出范围。" }, { status: 400 });
    }
    only = n - 1;
  }

  try {
    const rendered = await renderCards(outline, only);
    for (const card of rendered) {
      await saveCardPng(deckId, card.index, card.png);
    }
    return NextResponse.json({
      success: true,
      deckId,
      count: outline.cards.length,
      rendered: rendered.map((c) => c.index + 1),
      // 降到字号下限仍装不下的卡（1 起），UI 据此提示「文字过长，建议精简」
      overflow: rendered.filter((c) => c.overflow).map((c) => c.index + 1),
      width: OUTPUT_SIZE.width,
      height: OUTPUT_SIZE.height,
    });
  } catch (err) {
    if (err instanceof ChromeNotFoundError) {
      return NextResponse.json(
        {
          success: false,
          error: "本机未装 Chrome/Chromium，无法生成卡片（可设 CHROME_EXECUTABLE_PATH 指定路径）。",
        },
        { status: 503 },
      );
    }
    if (err instanceof FontsMissingError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 503 });
    }
    console.error("[cards/render] 渲染失败", { name: (err as { name?: string } | null)?.name });
    return NextResponse.json({ success: false, error: "卡片渲染失败，请重试。" }, { status: 500 });
  }
}
