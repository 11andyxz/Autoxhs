/**
 * 拆卡结果的 schema 与规整。
 *
 * 分工：模型只负责「内容怎么拆、每张放什么」；结构合法性（分组数、卡片角色、
 * 版式与内容量是否匹配）一律由这里的 clampOutline 用代码兜底 —— strict 模式对
 * minItems/maxItems 的支持不稳定，跟 lib/schema.ts 一个思路。
 *
 * 一条铁律：**不做静默截断**。文字太长会把中文句子切一半，宁可交给渲染层降字号，
 * 降到下限还塞不下就标记溢出、提示人工精简。
 */
import { z } from "zod";

import { LAYOUT_META, LAYOUT_IDS, PALETTE_IDS, STYLE_IDS } from "./tokens";
import {
  MAX_CARDS,
  MIN_CARDS,
  type Card,
  type CardOutline,
  type LayoutId,
  type PaletteId,
  type StyleId,
} from "./types";

const CardItemSchema = z.object({
  label: z.string().nullable(),
  text: z.string(),
});

const CardGroupSchema = z.object({
  heading: z.string(),
  items: z.array(z.string()),
});

const CardSchema = z.object({
  kind: z.enum(["cover", "content", "ending"]),
  layout: z.enum(["sparse", "balanced", "dense", "list", "comparison", "flow", "quadrant"]),
  title: z.string(),
  subtitle: z.string().nullable(),
  badge: z.string().nullable(),
  items: z.array(CardItemSchema),
  groups: z.array(CardGroupSchema),
});

export const OutlineSchema = z.object({
  topic: z.string(),
  style: z.enum(["notion", "cute", "bold", "warm", "minimal", "chalkboard"]),
  palette: z.enum(["default", "macaron", "warm", "neon"]),
  cards: z.array(CardSchema),
});

/** 模型返回不符合要求时抛出，触发一次自动重试（与 rewrite 同一套路）。 */
export class OutlineValidationError extends Error {}

/** 发给 OpenAI 的严格 JSON Schema。可选字段一律用 nullable，strict 模式要求全部 required。 */
export const OUTLINE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "style", "palette", "cards"],
  properties: {
    topic: { type: "string", description: "这叠卡片的主题，6~14 个中文字" },
    style: {
      type: "string",
      enum: STYLE_IDS,
      description:
        "视觉风格：notion=极简手记(干货/概念/工具)、cute=少女甜心(种草/日常)、" +
        "bold=高冲击(避坑/警示/对比)、warm=温暖生活(故事/情感)、" +
        "minimal=克制专业(商务/总结)、chalkboard=黑板课堂(教程/教学)",
    },
    palette: {
      type: "string",
      enum: PALETTE_IDS,
      description: "配色：default=用风格自带配色（多数情况选它）；其余为覆盖配色",
    },
    cards: {
      type: "array",
      description: `${MIN_CARDS}~${MAX_CARDS} 张卡：第 1 张必须是 cover，最后 1 张必须是 ending，中间是 content`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "layout", "title", "subtitle", "badge", "items", "groups"],
        properties: {
          kind: { type: "string", enum: ["cover", "content", "ending"] },
          layout: {
            type: "string",
            enum: LAYOUT_IDS,
            description: Object.entries(LAYOUT_META)
              .map(([id, m]) => `${id}=${m.hint}`)
              .join(" "),
          },
          title: { type: "string", description: "卡片主标题。封面 12~20 字要有钩子；内容页 8~16 字" },
          subtitle: {
            type: ["string", "null"],
            description: "副标题一句话，20~30 字。内容页多数不需要，传 null",
          },
          badge: {
            type: ["string", "null"],
            description: "左上角小角标，2~4 字如「干货」「收藏」「避坑」。不需要传 null",
          },
          items: {
            type: "array",
            description:
              "要点。balanced/dense/list/flow 用；comparison/quadrant 传空数组。" +
              "每条 text 控制在 10~24 字，写具体结论不要写空话",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "text"],
              properties: {
                label: {
                  type: ["string", "null"],
                  description: "要点前的 2~4 字短标签，如「格式」「第一步」。不需要传 null",
                },
                text: { type: "string" },
              },
            },
          },
          groups: {
            type: "array",
            description: "分组。comparison 正好 2 组、quadrant 正好 4 组；其它版式传空数组",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["heading", "items"],
              properties: {
                heading: { type: "string", description: "分组标题，2~8 字" },
                items: { type: "array", items: { type: "string" }, description: "该组 2~4 条，每条 4~14 字" },
              },
            },
          },
        },
      },
    },
  },
} as const;

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cleanNullable(s: string | null): string | null {
  if (s === null) return null;
  const t = cleanText(s);
  return t.length > 0 ? t : null;
}

/**
 * 把一张卡的版式与实际内容对齐。原则是「改版式去适应内容」，而不是「删内容去适应版式」：
 *  - comparison 需要正好 2 组、quadrant 需要正好 4 组；不满足就退回按要点走的版式
 *  - 要点条数超出该版式上限就升级到能装下的版式（list→dense），一条都不丢
 *  - 一条要点都没有的内容页退回 sparse（只剩标题，至少不是空框）
 */
function fitLayout(card: Card): LayoutId {
  const meta = LAYOUT_META[card.layout];
  if (meta.groups > 0) {
    if (card.groups.length === meta.groups) return card.layout;
    // 分组数不对：有要点就按要点排，没有就只留标题
    return card.items.length > 0 ? pickItemLayout(card.items.length) : "sparse";
  }
  if (card.items.length === 0) return "sparse";
  const [, max] = meta.items;
  if (card.items.length > max) return pickItemLayout(card.items.length);
  return card.layout;
}

/** 按要点条数挑一个装得下的版式。 */
function pickItemLayout(count: number): LayoutId {
  if (count <= 2) return "sparse";
  if (count <= 4) return "balanced";
  if (count <= 7) return "list";
  return "dense";
}

/**
 * 规整模型输出：清洗空白、对齐卡片角色、修正版式、夹紧张数。
 * 张数不足 MIN_CARDS 或封面缺失属于结构性失败，抛错触发重试。
 */
export function normalizeOutline(input: unknown, fallbackTopic: string): CardOutline {
  const parsed = OutlineSchema.parse(input);

  let cards: Card[] = parsed.cards.map((c) => ({
    kind: c.kind,
    layout: c.layout,
    title: cleanText(c.title),
    subtitle: cleanNullable(c.subtitle),
    badge: cleanNullable(c.badge),
    items: c.items
      .map((it) => ({ label: cleanNullable(it.label), text: cleanText(it.text) }))
      .filter((it) => it.text.length > 0),
    groups: c.groups
      .map((g) => ({
        heading: cleanText(g.heading),
        items: g.items.map(cleanText).filter((t) => t.length > 0),
      }))
      .filter((g) => g.heading.length > 0 && g.items.length > 0),
  }));

  cards = cards.filter((c) => c.title.length > 0);
  if (cards.length < MIN_CARDS) {
    throw new OutlineValidationError(`卡片数不足：${cards.length}`);
  }
  // 超出上限时从中间的内容页里砍（保住封面和结尾），不动任何一张卡的内部文字
  if (cards.length > MAX_CARDS) {
    cards = [...cards.slice(0, MAX_CARDS - 1), cards[cards.length - 1]];
  }

  // 首尾角色强制：封面和结尾都走 sparse，视觉上一头一尾干净利落
  cards[0] = { ...cards[0], kind: "cover", layout: "sparse" };
  const lastIdx = cards.length - 1;
  cards[lastIdx] = { ...cards[lastIdx], kind: "ending", layout: "sparse" };
  for (let i = 1; i < lastIdx; i += 1) {
    cards[i] = { ...cards[i], kind: "content", layout: fitLayout(cards[i]) };
  }

  const topic = cleanText(parsed.topic) || cleanText(fallbackTopic) || "小红书卡片";
  return {
    topic,
    style: parsed.style as StyleId,
    palette: parsed.palette as PaletteId,
    watermark: null, // 由路由层按设置填入，模型不参与
    cards,
  };
}
