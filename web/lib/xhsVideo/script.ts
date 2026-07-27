/**
 * 讲解脚本生成:把一篇小红书笔记(标题+正文,可选图片 OCR 文字)变成一段「视频分镜脚本」。
 * 复用 lib/openai 的 Responses API + Structured Outputs(与文案改写/评论生成同一套调用方式)。
 *
 * 输出的每个 segment = 一个镜头:显示第 imageIndex 张笔记原图 + 屏幕字幕 caption + 口播 narration。
 * 由渲染层把 narration 合成语音、把 caption 叠到图上,拼成视频。
 */
import { extractTextFromImages, getClient, getModel } from "@/lib/openai";

export type VideoSegment = {
  /** 本镜头显示哪一张笔记原图(0-based) */
  imageIndex: number;
  /** 屏幕字幕(短) */
  caption: string;
  /** 口播文案(会被 TTS 合成语音) */
  narration: string;
};

export type VideoScript = {
  /** 视频标题(用于文件名/展示) */
  title: string;
  segments: VideoSegment[];
};

const MAX_SEGMENTS = 8;
const MAX_CAPTION = 24; // 字幕过长会溢出画面下方字幕条
const MAX_NARRATION = 220; // 单镜头口播上限(避免单段语音过长)
const OCR_WHEN_DESC_UNDER = 40; // 正文太短(内容多在图里)时,先 OCR 图片补上下文

const SYSTEM_PROMPT = [
  "你是一名小红书图文笔记的「视频讲解」脚本作者。",
  "用户会给你一篇已发布笔记的标题、正文,以及图片数量 N(可能附带从图片里 OCR 出的文字)。",
  "请把它改写成一段竖屏短视频的口播讲解脚本,输出若干镜头(segment)。规则:",
  "1. 语言:简体中文,口语、自然、像博主本人对着镜头讲解,可以有轻微的口播语气词,但不要浮夸。",
  "2. 忠实于原笔记内容,不要编造原文没有的事实、数据或承诺。",
  `3. 镜头数量 3~${MAX_SEGMENTS} 个;每个镜头选一张最相关的图(imageIndex 取 0..N-1)。第一个镜头是开场钩子,最后一个是简短收尾。`,
  `4. 每个镜头两部分:narration 是口播(1~3 句,≤${MAX_NARRATION} 字);caption 是压在画面上的短字幕(≤${MAX_CAPTION} 字,提炼这一段的关键词/要点,不是照抄口播)。`,
  "5. title 给这条视频起一个吸引人的短标题(≤20 字)。",
  "只输出符合 schema 的 JSON,不要任何额外解释。",
].join("\n");

const SCRIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          imageIndex: { type: "integer" },
          caption: { type: "string" },
          narration: { type: "string" },
        },
        required: ["imageIndex", "caption", "narration"],
      },
    },
  },
  required: ["title", "segments"],
} as const;

export class ScriptGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptGenerationError";
  }
}

function buildUserContent(note: {
  title: string;
  desc: string;
  imageCount: number;
  imageText?: string;
}): string {
  const parts = [
    `图片数量 N = ${note.imageCount}(imageIndex 取 0..${Math.max(0, note.imageCount - 1)})`,
    `标题:${note.title || "(无)"}`,
    `正文:\n${note.desc || "(无正文)"}`,
  ];
  if (note.imageText && note.imageText.trim()) {
    parts.push(`图片中识别到的文字(供参考):\n${note.imageText.trim().slice(0, 2000)}`);
  }
  return parts.join("\n\n");
}

/** 把模型输出清洗成安全范围:钳制 imageIndex、截断超长文本、限制镜头数、剔除空口播。 */
function normalize(json: unknown, imageCount: number): VideoScript {
  const obj = (json ?? {}) as { title?: unknown; segments?: unknown };
  const rawSegments = Array.isArray(obj.segments) ? obj.segments : [];
  const maxIdx = Math.max(0, imageCount - 1);

  const segments: VideoSegment[] = [];
  for (const raw of rawSegments) {
    if (segments.length >= MAX_SEGMENTS) break;
    const s = (raw ?? {}) as { imageIndex?: unknown; caption?: unknown; narration?: unknown };
    const narration = typeof s.narration === "string" ? s.narration.trim() : "";
    if (!narration) continue; // 没有口播的镜头没有意义
    let idx = Number.isFinite(Number(s.imageIndex)) ? Math.floor(Number(s.imageIndex)) : 0;
    if (idx < 0) idx = 0;
    if (idx > maxIdx) idx = maxIdx;
    const caption = (typeof s.caption === "string" ? s.caption.trim() : "").slice(0, MAX_CAPTION);
    segments.push({ imageIndex: idx, caption, narration: narration.slice(0, MAX_NARRATION) });
  }

  if (!segments.length) {
    throw new ScriptGenerationError("模型没有生成任何有效镜头。");
  }

  const title = (typeof obj.title === "string" ? obj.title.trim() : "").slice(0, 40);
  return { title: title || "小红书笔记讲解", segments };
}

/**
 * 生成讲解脚本。note.images 用于:正文太短时先 OCR 补上下文(图文内容主要在图里的笔记)。
 * 出错(鉴权/限流/超时/输出异常)直接抛出,交路由层映射为提示。
 */
export async function generateVideoScript(note: {
  title: string;
  desc: string;
  images: string[];
}): Promise<VideoScript> {
  const imageCount = note.images.length;
  if (imageCount === 0) {
    throw new ScriptGenerationError("这篇笔记没有可用图片,暂时只支持图文笔记生成讲解视频。");
  }

  let imageText = "";
  if (note.desc.trim().length < OCR_WHEN_DESC_UNDER) {
    // 正文很短,内容多在图里:OCR 出图片文字给模型当上下文(失败则忽略,不阻断)。
    try {
      imageText = await extractTextFromImages(note.images, { maxImages: 8 });
    } catch {
      imageText = "";
    }
  }

  const client = getClient(90_000, 0); // 重输出、耗时长:关掉 SDK 自动重试避免超时翻倍
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent({ ...note, imageCount, imageText }) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "xhs_video_script",
        strict: true,
        schema: SCRIPT_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const text = response.output_text;
  if (!text) throw new ScriptGenerationError("模型输出为空。");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ScriptGenerationError("模型输出不是合法 JSON。");
  }
  return normalize(json, imageCount);
}
