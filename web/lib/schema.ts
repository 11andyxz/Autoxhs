import { z } from "zod";

/** 单个标题 */
export const TitleSchema = z.object({
  text: z.string(),
  style: z.string(),
});

/** 模型返回的完整结构 */
export const RewriteSchema = z.object({
  titles: z.array(TitleSchema),
  body: z.string(),
  tags: z.array(z.string()),
});

export type Title = z.infer<typeof TitleSchema>;
export type RewriteData = z.infer<typeof RewriteSchema>;

/**
 * 发送给 OpenAI 的严格 JSON Schema(Structured Outputs)。
 * 数量约束(8 个标题 / 5~10 个标签)在 normalizeRewrite 中用代码强制,
 * 避免依赖 strict 模式不一定支持的 minItems/maxItems。
 */
export const REWRITE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    titles: {
      type: "array",
      description: "正好 8 个小红书标题,风格各异",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "标题文本,20 个中文字符以内" },
          style: {
            type: "string",
            description: "标题风格,如 干货型/避坑型/结果型/疑问型/情绪共鸣型",
          },
        },
        required: ["text", "style"],
      },
    },
    body: { type: "string", description: "优化后的完整正文,保留换行和空行" },
    tags: {
      type: "array",
      description: "5~10 个以 # 开头、与内容高度相关的小红书标签",
      items: { type: "string" },
    },
  },
  required: ["titles", "body", "tags"],
} as const;

/** 模型返回不符合要求时抛出,触发一次自动重试 */
export class SchemaValidationError extends Error {}

function dedupeBy<T>(arr: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * 校验并规整模型输出:
 * - titles 去重后必须正好 8 个
 * - body 不可为空(仅去除首尾空白,保留内部换行)
 * - tags 规整为以 # 开头、去空格、去重,数量 5~10
 * 不满足时抛出 SchemaValidationError。
 */
export function normalizeRewrite(input: unknown): RewriteData {
  const parsed = RewriteSchema.parse(input);

  let titles = parsed.titles
    .map((t) => ({ text: t.text.trim(), style: t.style.trim() || "推荐" }))
    .filter((t) => t.text.length > 0);
  titles = dedupeBy(titles, (t) => t.text);
  if (titles.length > 8) titles = titles.slice(0, 8);

  const body = parsed.body.trim();

  // 把所有 tag 字符串合并后按 # 重新拆分,稳健处理「缺少 #」「多个 tag 挤在一起」等情况
  const rawTags = parsed.tags.join(" ");
  let tags = rawTags
    .split("#")
    .map((s) => s.trim().replace(/\s+/g, ""))
    .filter((s) => s.length > 0)
    .map((s) => `#${s}`);
  tags = dedupeBy(tags, (s) => s.toLowerCase());
  if (tags.length > 10) tags = tags.slice(0, 10);

  if (titles.length !== 8) {
    throw new SchemaValidationError("titles 数量不为 8");
  }
  if (!body) {
    throw new SchemaValidationError("body 为空");
  }
  if (tags.length < 5 || tags.length > 10) {
    throw new SchemaValidationError("tags 数量不在 5~10 范围");
  }

  return { titles, body, tags };
}
