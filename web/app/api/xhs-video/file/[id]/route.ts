import { NextResponse, type NextRequest } from "next/server";

import { readVideo, sanitizeVideoId } from "@/lib/xhsVideo/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 下发生成好的讲解视频 mp4。
 * 默认作为附件下载;带 ?inline=1 时以 inline 返回,供页面里 <video> 内嵌预览。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const { id } = await params;
  const safe = sanitizeVideoId(id);
  if (!safe) {
    return NextResponse.json({ success: false, error: "无效的视频 ID。" }, { status: 400 });
  }

  const data = await readVideo(safe);
  if (!data) {
    return NextResponse.json({ success: false, error: "视频不存在或已被清理。" }, { status: 404 });
  }

  const disposition = inline ? "inline" : "attachment";
  const filename = `xhs-video-${safe}.mp4`;
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(data.length),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
