import { NextResponse, type NextRequest } from "next/server";

import { readCardPng, sanitizeDeckId } from "@/lib/xiaohongshu/cards/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 下发某一叠里的第 n 张卡片 PNG（n 从 1 起，与 UI 编号一致）。
 * 私有、不缓存：卡片会被「重生成这张」原地覆盖，缓存住就会看到旧图。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ deckId: string; n: string }> },
) {
  const { deckId, n } = await params;
  const safe = sanitizeDeckId(deckId);
  const index = Number(n) - 1;
  if (!safe || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ success: false, error: "无效的卡片地址。" }, { status: 400 });
  }

  const data = await readCardPng(safe, index);
  if (!data) {
    return NextResponse.json({ success: false, error: "卡片不存在或已被清理。" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(data.length),
      "Content-Disposition": `inline; filename="card-${safe}-${index + 1}.png"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
