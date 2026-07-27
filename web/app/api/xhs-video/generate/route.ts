import { NextResponse, type NextRequest } from "next/server";

import { MissingApiKeyError } from "@/lib/openai";
import { ChromeNotFoundError } from "@/lib/pdfTools/wordToPdf";
import { FfmpegNotFoundError } from "@/lib/xhsVideo/ffmpeg";
import { fetchNoteDetail, NoteFetchError } from "@/lib/xhsVideo/note";
import { renderNoteVideo } from "@/lib/xhsVideo/render";
import { generateVideoScript, ScriptGenerationError } from "@/lib/xhsVideo/script";
import { newVideoId, saveVideo } from "@/lib/xhsVideo/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 视频渲染是长任务(TTS + 无头 Chrome 截图 + ffmpeg)。仅供本地运行:
// 本机 next dev 不强制超时;maxDuration 只在部署时生效(公网模式下本路由已被 middleware 404)。
export const maxDuration = 300;

/**
 * 从一条已发布笔记链接生成「视频讲解」(图文轮播 + AI 口播 + 字幕),存到本地供下载。
 * 不发布回小红书。整条链路依赖本机:rednote 服务(取笔记)、Chrome(渲染帧)、ffmpeg-static(合成)。
 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!url) {
    return NextResponse.json({ success: false, error: "请提供笔记链接。" }, { status: 400 });
  }

  try {
    // 1. 抓取笔记
    const note = await fetchNoteDetail(url);
    if (!note.images.length) {
      return NextResponse.json(
        { success: false, error: "这篇笔记没有可用图片,暂时只支持图文笔记生成讲解视频。" },
        { status: 422 },
      );
    }

    // 2. 生成讲解脚本
    const script = await generateVideoScript(note);

    // 3. 渲染合成
    const { video, segmentCount, durationSec } = await renderNoteVideo({ note, script });

    // 4. 落盘
    const id = newVideoId();
    await saveVideo(id, video);

    return NextResponse.json({
      success: true,
      data: {
        id,
        title: script.title,
        segmentCount,
        durationSec: Math.round(durationSec),
        sizeBytes: video.length,
        segments: script.segments.map((s) => ({ caption: s.caption, narration: s.narration })),
        note: { title: note.title, user: note.user, imageCount: note.images.length },
      },
    });
  } catch (err) {
    if (err instanceof NoteFetchError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 502 });
    }
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json(
        { success: false, error: "未配置 OPENAI_API_KEY,无法生成脚本与配音。" },
        { status: 503 },
      );
    }
    if (err instanceof ScriptGenerationError) {
      return NextResponse.json({ success: false, error: `脚本生成失败:${err.message}` }, { status: 502 });
    }
    if (err instanceof ChromeNotFoundError) {
      return NextResponse.json(
        { success: false, error: "未找到本机 Chrome,无法渲染视频画面。" },
        { status: 503 },
      );
    }
    if (err instanceof FfmpegNotFoundError) {
      return NextResponse.json(
        { success: false, error: "ffmpeg 不可用,无法合成视频。" },
        { status: 503 },
      );
    }
    console.error("[xhs-video/generate] 失败", { name: (err as Error)?.name, msg: (err as Error)?.message });
    return NextResponse.json(
      { success: false, error: `生成失败:${(err as Error)?.message || "未知错误"}` },
      { status: 500 },
    );
  }
}
