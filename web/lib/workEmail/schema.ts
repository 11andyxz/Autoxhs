import { z } from "zod";

/**
 * 「工作邮件自动发送」的结构化输出定义。
 * - zod schema 用于运行时校验 / 规整(normalize)
 * - JSON Schema 用于 OpenAI Structured Outputs(strict 模式)
 *
 * 模型只产出两件东西:邮件主题(subject)与正文(body)。正文用极简 markdown
 * (## 小标题 / - 项目符号 / 1. 有序列表 / **加粗** / 空行分段)书写,前端与
 * 发信端用同一个确定性渲染器转成 HTML,既方便预览也方便用户在一个文本框里改。
 */

const MAX = {
  subject: 300,
  body: 20_000,
} as const;

export const WorkEmailSchema = z.object({
  subject: z.string().max(MAX.subject),
  body: z.string().max(MAX.body),
});

export type WorkEmailDraft = z.infer<typeof WorkEmailSchema>;

/** 模型返回不符合要求时抛出,触发一次自动重试 */
export class SchemaValidationError extends Error {}

/** 发送给 OpenAI 的严格 JSON Schema(Structured Outputs) */
export const WORK_EMAIL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: {
      type: "string",
      description:
        "邮件主题行。沿用上一封邮件的主题格式,只把周期换成目标周,例如 'Technical Product Analyst Weekly Work Plan | July 6–10'。",
    },
    body: {
      type: "string",
      description:
        "完整邮件正文,从问候语(如 'Hi Bin Meng,')开始,到落款(如 'Best,\\nZheng Xiong\\nForwardCraft\\nAndyXiongZheng LLC')结束。用极简 markdown 书写:## 表示小标题,- 表示无序项,'1. ' 表示有序项,**text** 表示加粗,段落之间空一行。不要使用代码块或表格,不要输出 JSON 以外的任何内容。",
    },
  },
  required: ["subject", "body"],
} as const;

/**
 * 校验并规整模型输出:去首尾空白;主题折成单行(去掉换行,防邮件头注入);
 * subject / body 任一为空则抛错触发重试。
 */
export function normalizeDraft(input: unknown): WorkEmailDraft {
  const parsed = WorkEmailSchema.parse(input);
  const subject = parsed.subject.replace(/[\r\n]+/g, " ").trim();
  const body = parsed.body.replace(/\r\n/g, "\n").trim();
  if (!subject) throw new SchemaValidationError("邮件主题为空");
  if (!body) throw new SchemaValidationError("邮件正文为空");
  return { subject, body };
}
