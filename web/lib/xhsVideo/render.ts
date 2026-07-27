/**
 * 编排层:把「笔记详情 + 讲解脚本」渲染成一段可下载的 mp4(每镜 AI 配图 + 逐句同步字幕)。
 *
 * 管线:每镜 AI 生成配图 + 每段口播 TTS → 探测每段音频时长 → 每段口播拆成逐句字幕并按时长切成多帧
 *      → Chrome 截图成帧 → 各段音频拼成主音轨 → ffmpeg 按帧时长 + 主音轨合成成片。
 * 全程本机跑(依赖本机 Chrome + ffmpeg-static + OPENAI_API_KEY)。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { synthesizeSpeech } from "@/lib/openai";

import { buildVideoFromFrames, concatAudio, probeDuration } from "./ffmpeg";
import { generateSegmentImages } from "./image";
import { renderSlides, type SlideSpec } from "./slide";
import type { VideoScript } from "./script";
import { distributeDurations, splitNarrationIntoLines } from "./subtitle";

export type RenderResult = {
  /** 最终 mp4 字节 */
  video: Buffer;
  /** 镜头数 */
  segmentCount: number;
  /** 总时长(秒) */
  durationSec: number;
};

export type RenderInput = {
  note: { title: string; user: string; images: string[] };
  script: VideoScript;
};

/** 生成讲解视频。任一底层错误(生图/TTS/Chrome/ffmpeg)向上抛,由路由层映射为提示。 */
export async function renderNoteVideo(input: RenderInput): Promise<RenderResult> {
  const { note, script } = input;
  const segments = script.segments;
  const handle = note.user ? `@${note.user}` : undefined;

  // 1. 并行:每镜 AI 配图 + 每段口播 TTS
  const [images, audios] = await Promise.all([
    generateSegmentImages(note, script),
    Promise.all(segments.map((s) => synthesizeSpeech(s.narration))),
  ]);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-video-"));
  try {
    // 2. 落盘各段音频并探测时长
    const audioPaths: string[] = [];
    const durations: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const ap = path.join(workDir, `audio-${i}.mp3`);
      await fs.writeFile(ap, audios[i]);
      audioPaths.push(ap);
      durations.push(await probeDuration(ap));
    }

    // 3. 每段拆逐句字幕、分配时长,展开成「帧规格 + 帧时长」的全局时间轴
    const specs: SlideSpec[] = [];
    const frameDurations: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      let lines = splitNarrationIntoLines(seg.narration);
      if (!lines.length) lines = [seg.caption || ""]; // 兜底:至少一帧
      const lineDur = distributeDurations(lines, durations[i]);
      for (let j = 0; j < lines.length; j += 1) {
        specs.push({
          imageDataUrl: images[i] ?? null,
          topLabel: seg.caption || undefined,
          subtitle: lines[j] || undefined,
          handle,
        });
        frameDurations.push(lineDur[j]);
      }
    }

    // 4. Chrome 渲染所有帧
    const frames = await renderSlides(specs);

    // 5. 落盘帧 + 拼主音轨
    const framePaths: string[] = [];
    for (let i = 0; i < frames.length; i += 1) {
      const fp = path.join(workDir, `frame-${i}.png`);
      await fs.writeFile(fp, frames[i]);
      framePaths.push(fp);
    }

    const audioListPath = path.join(workDir, "audios.txt");
    await fs.writeFile(audioListPath, audioPaths.map((p) => `file '${p}'`).join("\n"), "utf8");
    const masterAudio = path.join(workDir, "master.mp3");
    await concatAudio(audioListPath, masterAudio);

    // 6. 帧清单(每帧 file + duration;末帧重复一次让其时长生效)
    const listLines: string[] = [];
    for (let i = 0; i < framePaths.length; i += 1) {
      listLines.push(`file '${framePaths[i]}'`);
      listLines.push(`duration ${frameDurations[i].toFixed(3)}`);
    }
    if (framePaths.length) listLines.push(`file '${framePaths[framePaths.length - 1]}'`);
    const framesListPath = path.join(workDir, "frames.txt");
    await fs.writeFile(framesListPath, listLines.join("\n"), "utf8");

    // 7. 合成
    const outPath = path.join(workDir, "out.mp4");
    await buildVideoFromFrames(framesListPath, masterAudio, outPath);

    const video = await fs.readFile(outPath);
    const durationSec = durations.reduce((a, b) => a + b, 0);
    return { video, segmentCount: segments.length, durationSec };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
