/**
 * 拆卡：一次文本调用，把「标题 + 正文」拆成 3~10 张卡的结构化 outline。
 *
 * 模型只做内容工作（哪句当标题、哪些当要点、每张用什么版式），排版和配色全是
 * 本地 CSS 常量 —— 所以这一步便宜（分币级）、快（几秒），且不影响出图的可复现性。
 *
 * 拆卡框架（封面 hook → 内容页 → 结尾 CTA、按内容信号选风格与版式）取自
 * baoyu-xhs-images skill 的 Content Breakdown Principles / Auto-Selection 两节。
 */
import type OpenAI from "openai";

import { getClient, getModel } from "@/lib/openai";

import {
  OUTLINE_JSON_SCHEMA,
  OutlineValidationError,
  normalizeOutline,
} from "./schema";
import { LAYOUT_META, STYLES } from "./tokens";
import {
  MAX_CARDS,
  MIN_CARDS,
  type CardOutline,
  type PaletteId,
  type StyleId,
} from "./types";

const MAX_BODY_CHARS = 6000;
const TIMEOUT_MS = 90_000;

export type OutlineParams = {
  title: string;
  body: string;
  tags?: string[];
  /** 指定风格；"auto" 让模型按内容选 */
  style?: StyleId | "auto";
  /** 指定配色；"auto" 让模型选（多数情况会选 default = 风格自带配色） */
  palette?: PaletteId | "auto";
  /** 指定张数；"auto" 让模型按信息量定 */
  cardCount?: number | "auto";
  /** 右下角水印，通常是账号名 */
  watermark?: string | null;
  /**
   * 追加给模型的额外要求（拼进【要求】）。
   * 定时发布用它把「本篇的讲法 / 封面 badge / 别写成警告腔」传下来 —— 拆卡只看得到标题和正文，
   * 不说清楚它就会自己另写一个警示味的封面。
   */
  hint?: string;
};

const SYSTEM_PROMPT = `你是小红书图文卡片的内容策划。把用户给的一篇笔记，拆成一叠可以直接发布的图片卡。

# 卡片结构（固定）
- 第 1 张：封面(cover)。只有一个大标题 + 一句副标题，负责钩住人点进来。标题要具体、有信息量或有冲突感，不要标题党套话。
- 中间若干张：内容(content)。每张只讲一个完整的点，标题是这个点的结论，要点是支撑。
- 最后 1 张：结尾(ending)。一句收束 + 引导互动。

# 版式怎么选
${Object.entries(LAYOUT_META)
  .map(([id, m]) => `- ${id}：${m.hint}`)
  .join("\n")}
选版式的依据是**内容本身的形状**，不是好看：能排成步骤就用 flow，能两边对照就用 comparison，
是并列清单就用 list，点很多且短就用 dense，只有三四个要点就用 balanced。
不要整叠都用同一个版式；也不要为了用某个版式硬凑内容。

# 风格怎么选
${Object.entries(STYLES)
  .map(([id, s]) => `- ${id}（${s.name}）`)
  .join("\n")}
按内容气质选：干货/概念/工具类→notion；种草/日常分享→cute；避坑/警示/强对比→bold；
故事/情感→warm；商务/专业总结→minimal；教程/教学→chalkboard。

# 写作要求
- 全部用中文，跟原文同一个语气。
- 卡片上的字是「印在图上的」，必须短。要点每条 10~24 字，写具体结论，不要写「很重要」「要注意」这种空话。
- 不要把原文整段搬上卡片。卡片是提炼，完整正文会另外放在笔记正文里。
- 不要在卡片上写「第 1 张」「下一页」这类导航词，也不要写页码（渲染时自动加）。
- badge 只在确实有用时给（如「干货」「避坑」「收藏」），大部分内容页传 null。

只输出符合 schema 的 JSON。`;

function buildUserInput(params: OutlineParams): string {
  const parts = [`【标题】${params.title.trim()}`];
  const body = params.body.trim().slice(0, MAX_BODY_CHARS);
  parts.push(`【正文】\n${body}`);
  if (params.tags?.length) parts.push(`【标签】${params.tags.join(" ")}`);

  const asks: string[] = [];
  if (params.style && params.style !== "auto") {
    asks.push(`风格必须用 "${params.style}"`);
  }
  if (params.palette && params.palette !== "auto") {
    asks.push(`配色必须用 "${params.palette}"`);
  }
  if (typeof params.cardCount === "number") {
    asks.push(`卡片数必须正好 ${params.cardCount} 张（含封面和结尾）`);
  } else {
    asks.push(`卡片数按信息量自己定，${MIN_CARDS}~${MAX_CARDS} 张之间；内容撑不满就少几张，不要注水`);
  }
  const hint = params.hint?.trim();
  if (hint) asks.push(hint);
  parts.push(`【要求】${asks.join("；")}`);
  return parts.join("\n\n");
}

async function callModel(
  client: OpenAI,
  params: OutlineParams,
  repair: boolean,
): Promise<CardOutline> {
  const input: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  if (repair) {
    input.push({
      role: "system",
      content:
        `上一次输出不符合要求。请重新输出：卡片数 ${MIN_CARDS}~${MAX_CARDS} 张，` +
        "第 1 张 kind=cover、最后 1 张 kind=ending，每张 title 都不能为空；" +
        "comparison 必须正好 2 组 groups，quadrant 必须正好 4 组，其它版式 groups 传空数组。只输出 JSON。",
    });
  }
  input.push({ role: "user", content: buildUserInput(params) });

  const response = await client.responses.create({
    model: getModel(),
    input,
    text: {
      format: {
        type: "json_schema",
        name: "xhs_card_outline",
        strict: true,
        schema: OUTLINE_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const text = response.output_text;
  if (!text) throw new OutlineValidationError("模型输出为空");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OutlineValidationError("模型输出不是合法 JSON");
  }
  return normalizeOutline(json, params.title);
}

function isZodError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: string }).name === "ZodError"
  );
}

/**
 * 生成一叠卡片的 outline。只在「输出结构不合要求」时自动重试一次，
 * 其余错误（鉴权、限流、超时）直接抛出，交由路由层映射成用户提示。
 *
 * 用户显式指定的 style/palette/watermark 在这里最终覆盖一次 —— 模型偶尔会忽略要求，
 * 而这三个是纯展示参数，本来就该由调用方说了算。
 */
export async function buildOutline(params: OutlineParams): Promise<CardOutline> {
  const client = getClient(TIMEOUT_MS, 0); // 输出较长，关掉 SDK 自动重试避免超时翻倍
  let outline: CardOutline;
  try {
    outline = await callModel(client, params, false);
  } catch (err) {
    if (err instanceof OutlineValidationError || isZodError(err)) {
      outline = await callModel(client, params, true);
    } else {
      throw err;
    }
  }

  return {
    ...outline,
    style: params.style && params.style !== "auto" ? params.style : outline.style,
    palette: params.palette && params.palette !== "auto" ? params.palette : outline.palette,
    watermark: params.watermark?.trim() || null,
  };
}
