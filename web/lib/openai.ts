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
