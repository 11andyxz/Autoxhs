import OpenAI from "openai";

import { SYSTEM_PROMPT } from "./prompt";
import {
  REWRITE_JSON_SCHEMA,
  SchemaValidationError,
  normalizeRewrite,
  type RewriteData,
} from "./schema";

const TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = "gpt-5.5";

/** OPENAI_API_KEY 未配置时抛出 */
export class MissingApiKeyError extends Error {}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError("OPENAI_API_KEY 未配置");
  }
  return new OpenAI({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
}

function getModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

type ChatRole = "system" | "user";

async function callModel(
  client: OpenAI,
  content: string,
  repair: boolean,
): Promise<RewriteData> {
  const input: Array<{ role: ChatRole; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  if (repair) {
    // 仅在重试时追加修复指令(属于我们自己的开发者指令,不是用户输入)
    input.push({
      role: "system",
      content:
        "上一次输出不符合要求。请严格遵守:titles 必须正好 8 个且互不相同;tags 必须 5~10 个、各自以 # 开头且不重复;body 不能为空。只输出符合 schema 的 JSON,不要附加任何解释。",
    });
  }

  input.push({ role: "user", content });

  const response = await client.responses.create({
    model: getModel(),
    input,
    text: {
      format: {
        type: "json_schema",
        name: "xhs_rewrite",
        strict: true,
        schema: REWRITE_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const text = response.output_text;
  if (!text) {
    throw new SchemaValidationError("模型输出为空");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SchemaValidationError("模型输出不是合法 JSON");
  }

  return normalizeRewrite(json);
}

const OCR_PROMPT =
  "请提取这些图片中的所有文字,按图片顺序、从上到下输出,尽量保留原有换行与分段。" +
  "只输出文字本身,不要翻译、不要总结、不要添加任何解释或标注。";
const MAX_OCR_IMAGES = 12;

/** 下载图片并转为 data URL(供多模态输入);失败的跳过 */
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/webp";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** OCR:把若干图片里的文字用多模态模型提取出来(返回纯文本) */
export async function extractTextFromImages(imageUrls: string[]): Promise<string> {
  const client = getClient();
  const dataUrls: string[] = [];
  for (const url of imageUrls.slice(0, MAX_OCR_IMAGES)) {
    const d = await fetchImageAsDataUrl(url);
    if (d) dataUrls.push(d);
  }
  if (!dataUrls.length) throw new Error("没有可用的图片(下载失败或已过期)");

  const content = [
    { type: "input_text" as const, text: OCR_PROMPT },
    ...dataUrls.map((image_url) => ({
      type: "input_image" as const,
      image_url,
      detail: "auto" as const,
    })),
  ];

  const response = await client.responses.create({
    model: getModel(),
    input: [{ role: "user", content }],
  });
  return (response.output_text ?? "").trim();
}

// ---- GPT 生图：根据输入主题生成小红书竖版封面（默认带账号水印） ----
const DEFAULT_IMAGE_MODEL = "gpt-image-2"; // OpenAI 生图模型；可用 OPENAI_IMAGE_MODEL 覆盖
const COVER_HANDLE = "@北美熊哥聊求职";
const COVER_SIZE = "1024x1536"; // 竖版 2:3，贴近小红书封面比例

function getImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

/** 前置条件：固定的封面生成规格 + 默认账号水印，用户输入作为主标题/主题。 */
function buildCoverPrompt(userPrompt: string): string {
  return [
    "为小红书「北美留学 / 求职」博主生成一张竖版封面图（适合 3:4 / 2:3 展示）。",
    "整体风格：简洁现代、干净留白、专业可信；浅色纯净背景配深色中文大标题；",
    "文字排版清晰、字号大、无错别字、无乱码；不要真实人物肖像、不要二维码、不要网址、不要多余 logo。",
    `封面主标题 / 主题（作为画面醒目的中文大标题，可适当提炼精简）：${userPrompt}`,
    `在画面底部居中放一行低调小字账号名："${COVER_HANDLE}"（务必完整、正确、清晰可读）。`,
  ].join("\n");
}

/**
 * 调用 OpenAI 生图，根据用户主题生成竖版小红书封面，返回 PNG 字节。
 * 默认在提示里要求带上账号水印 @北美熊哥聊求职。
 */
export async function generateCoverImage(userPrompt: string): Promise<Buffer> {
  const client = getClient();
  const result = await client.images.generate({
    model: getImageModel(),
    prompt: buildCoverPrompt(userPrompt),
    size: COVER_SIZE,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("生图返回为空");
  return Buffer.from(b64, "base64");
}

function isZodError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ZodError"
  );
}

/**
 * 调用模型生成文案。仅在「输出格式/数量不符合要求」时自动重试一次,
 * 其余错误(鉴权、限流、超时等)直接抛出,交由路由层映射为用户提示。
 */
export async function rewriteCopy(content: string): Promise<RewriteData> {
  const client = getClient();
  try {
    return await callModel(client, content, false);
  } catch (err) {
    if (err instanceof SchemaValidationError || isZodError(err)) {
      return await callModel(client, content, true);
    }
    throw err;
  }
}
