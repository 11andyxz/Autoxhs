import { type NextRequest, NextResponse } from "next/server";

import { getCramCard } from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getOrSynthesize } from "@/lib/job-hunter/interview/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 读这张卡的「正面」(面试官念题)。走 GET 是为了能直接喂给 <audio> 并吃上浏览器缓存:
 *  - 音频本身按文本哈希缓存在库里(ip_tts_cache),同一道题只合成一次。
 *  - 响应带 ETag + max-age,同一台机器再读同一张卡连请求都不发。
 * 题目文字不进 URL(卡片内容来自简历,属敏感信息),只传卡片 id。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少卡片 id。");

  try {
    const card = await getCramCard(id);
    if (!card) return bad("卡片不存在。", 404);

    // 单词卡念英文本身(extra.en),问答卡念问题(front)。
    let text = (card.front ?? "").trim();
    if (card.kind === "word") {
      try {
        const extra = card.extra_json ? (JSON.parse(card.extra_json) as { en?: unknown }) : null;
        if (typeof extra?.en === "string" && extra.en.trim()) text = extra.en.trim();
      } catch {
        /* extra 坏了就用 front */
      }
    }
    if (!text) return bad("这张卡没有可朗读的题面。", 404);

    const { audio, hash } = await getOrSynthesize(text);

    // 文本没变 → hash 没变 → 直接 304,连音频都不用回传。
    const etag = `"${hash}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }

    return new NextResponse(new Uint8Array(audio) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        ETag: etag,
        // private:题面来自用户简历,只允许浏览器自己缓存,不给中间代理缓存。
        "Cache-Control": "private, max-age=604800, must-revalidate",
      },
    });
  } catch (err) {
    return fail(err, "cram-speak");
  }
}
