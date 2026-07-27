/**
 * ffmpeg 合成:用 ffmpeg-static 自带的二进制(免系统安装)。
 *
 * 逐句同步字幕的做法:
 *  1. 每段配音 mp3 拼成一条主音轨(concat demuxer,直接 copy)。
 *  2. 每一「行字幕」渲染成一帧 PNG,用 concat demuxer 的 duration 指令让每帧按其时长停留,
 *     组成视频轨(帧时长之和 == 主音轨时长,画面与配音逐句对齐)。
 *  3. 两轨相 mux,输出 H.264 + AAC 的 mp4(+faststart 便于网页边下边播)。
 *
 * 时长探测用 ffmpeg 自身解析(parseDuration),不依赖 ffmpeg-static 未附带的 ffprobe。
 */
import { spawn } from "node:child_process";

import ffmpegStatic from "ffmpeg-static";

import { VIDEO_HEIGHT, VIDEO_WIDTH } from "./slide";

export class FfmpegNotFoundError extends Error {
  constructor() {
    super("未找到 ffmpeg 二进制(ffmpeg-static 未正确安装)。");
    this.name = "FfmpegNotFoundError";
  }
}

function binary(): string {
  const p = ffmpegStatic as unknown as string | null;
  if (!p) throw new FfmpegNotFoundError();
  return p;
}

/** 跑一次 ffmpeg,返回 stderr(用于时长解析);非零退出时抛错并带上 stderr 尾部。 */
function run(args: string[], tolerateNonZero = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 16000) err = err.slice(-16000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || tolerateNonZero) resolve(err);
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-1200)}`));
    });
  });
}

/** 用 ffmpeg 读取媒体时长(秒)。ffmpeg 只给 -i 会以非零码退出,属正常,从 stderr 解析。 */
export async function probeDuration(file: string): Promise<number> {
  const stderr = await run(["-i", file], true);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) throw new Error("无法读取音频时长");
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 把多段 mp3 拼成一条主音轨(同为 tts-1 输出、编码一致,可直接 copy)。 */
export async function concatAudio(listFile: string, outMp3: string): Promise<void> {
  await run(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outMp3]);
}

const SCALE_PAD =
  `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

/**
 * 用「帧清单(含每帧 duration)」+ 主音轨合成最终视频。
 * framesListFile 为 concat demuxer 清单:每帧 `file '..'` 后跟 `duration <秒>`,
 * 末帧需再列一次(concat demuxer 会忽略最后一个 duration,重复末帧以让其时长生效)。
 */
export async function buildVideoFromFrames(
  framesListFile: string,
  audioFile: string,
  outMp4: string,
): Promise<void> {
  await run([
    "-y",
    "-f", "concat", "-safe", "0", "-i", framesListFile,
    "-i", audioFile,
    "-vf", SCALE_PAD,
    "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    "-shortest",
    "-movflags", "+faststart",
    outMp4,
  ]);
}
