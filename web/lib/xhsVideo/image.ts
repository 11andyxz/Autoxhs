/**
 * 为每个分镜生成一张 AI 配图(gpt-image-2),用作该镜画面背景。
 * 生成失败的镜头回退到笔记原图(按序取一张),再不行则由幻灯片用渐变兜底。
 */
import { generateImageFromPrompt } from "@/lib/openai";

import { downloadImagesAsDataUrls } from "./media";
import type { VideoScript } from "./script";

/** gpt-image-2 竖版 2:3,贴近竖屏视频(9:16 会在幻灯片里以 cover 裁切填满)。 */
const SEGMENT_IMAGE_SIZE = "1024x1536";

/** 为单个分镜构造生图提示:干净、无文字(文字由字幕层叠加)、竖版、专业现代。 */
function buildSegmentPrompt(topic: string, caption: string, narration: string): string {
  return [
    "为一条中文竖屏短视频生成一张背景配图。",
    `视频主题:${topic}`,
    `本镜要点:${caption || narration}`,
    `本镜口播(仅供理解画面内容,不要把文字画进图里):${narration}`,
    "风格要求:简洁现代、专业可信、明亮干净的构图,适合作为竖屏视频满屏背景;",
    "画面里不要出现任何文字、字母、数字、水印、logo 或二维码(文字会由视频另行叠加);",
    "不要出现真实人物的清晰正脸肖像;整体色调统一、留白得当,便于在上面叠加白色字幕。",
  ].join("\n");
}

/** 把 PNG 字节转成 data URL(供幻灯片内联)。 */
function pngToDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/**
 * 为脚本里每个分镜生成配图,返回与 segments 等长的 data URL 数组(失败位置回退原图 / null)。
 * 并行生成;单张失败不影响其余。
 */
export async function generateSegmentImages(
  note: { title: string; images: string[] },
  script: VideoScript,
): Promise<Array<string | null>> {
  // 先并行下载原图作为兜底(失败为 null)
  const fallbacks = await downloadImagesAsDataUrls(note.images);
  const topic = script.title || note.title;

  return Promise.all(
    script.segments.map(async (seg, i) => {
      try {
        const png = await generateImageFromPrompt(
          buildSegmentPrompt(topic, seg.caption, seg.narration),
          SEGMENT_IMAGE_SIZE,
        );
        return pngToDataUrl(png);
      } catch {
        // 生图失败:回退到笔记原图(按镜头序循环取),再没有就 null(幻灯片用渐变兜底)
        if (fallbacks.length) return fallbacks[i % fallbacks.length];
        return null;
      }
    }),
  );
}
