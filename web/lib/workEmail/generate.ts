import type OpenAI from "openai";

import { getClient, getModel } from "@/lib/openai";

import { buildUserMessage, REPAIR_CLAUSE, SYSTEM_PROMPT } from "./prompt";
import {
  normalizeDraft,
  SchemaValidationError,
  WORK_EMAIL_JSON_SCHEMA,
  type WorkEmailDraft,
} from "./schema";

const TIMEOUT_MS = 90_000;

type ChatRole = "system" | "user";

function isZodError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ZodError"
  );
}

async function callModel(
  client: OpenAI,
  priorEmailText: string,
  recipientName: string,
  targetWeek: string,
  repair: boolean,
): Promise<WorkEmailDraft> {
  const input: Array<{ role: ChatRole; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  if (repair) {
    input.push({ role: "system", content: REPAIR_CLAUSE });
  }

  input.push({
    role: "user",
    content: buildUserMessage(priorEmailText, recipientName, targetWeek),
  });

  const response = await client.responses.create({
    model: getModel(),
    input,
    text: {
      format: {
        type: "json_schema",
        name: "work_email",
        strict: true,
        schema: WORK_EMAIL_JSON_SCHEMA as unknown as Record<string, unknown>,
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

  return normalizeDraft(json);
}

/**
 * 根据「上一封周报工作计划邮件」生成下一封邮件草稿(主题 + 正文)。
 * 仅在「输出格式/内容不符合要求」时自动重试一次;其余错误(鉴权、限流、超时等)
 * 直接抛出,交由路由层映射为用户提示。
 */
export async function generateWorkEmail(
  priorEmailText: string,
  recipientName: string,
  targetWeek: string,
): Promise<WorkEmailDraft> {
  const client = getClient(TIMEOUT_MS);
  try {
    return await callModel(client, priorEmailText, recipientName, targetWeek, false);
  } catch (err) {
    if (err instanceof SchemaValidationError || isZodError(err)) {
      return await callModel(client, priorEmailText, recipientName, targetWeek, true);
    }
    throw err;
  }
}
