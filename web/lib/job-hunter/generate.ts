import type OpenAI from "openai";

import { getClient, getModel } from "@/lib/openai";

import { buildSystemPrompt, buildUserMessage, REPAIR_CLAUSE } from "./prompt";
import {
  JOB_HUNTER_JSON_SCHEMA,
  SchemaValidationError,
  normalizeResult,
  type JobHunterResult,
} from "./schema";

// 简历 + 求职信 + 分析的输出较大,给比默认更宽松的超时
const TIMEOUT_MS = 120_000;

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
  resumeText: string,
  jdText: string,
  allowEmbellish: boolean,
  repair: boolean,
): Promise<JobHunterResult> {
  const input: Array<{ role: ChatRole; content: string }> = [
    { role: "system", content: buildSystemPrompt(allowEmbellish) },
  ];

  if (repair) {
    input.push({ role: "system", content: REPAIR_CLAUSE });
  }

  input.push({ role: "user", content: buildUserMessage(resumeText, jdText) });

  const response = await client.responses.create({
    model: getModel(),
    input,
    text: {
      format: {
        type: "json_schema",
        name: "tailored_resume",
        strict: true,
        schema: JOB_HUNTER_JSON_SCHEMA as unknown as Record<string, unknown>,
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

  return normalizeResult(json);
}

/**
 * 根据原简历 + 目标 JD 生成针对性的简历、求职信与匹配分析。
 * 仅在「输出格式/内容不符合要求」时自动重试一次;其余错误(鉴权、限流、超时等)
 * 直接抛出,交由路由层映射为用户提示。
 */
export async function generateTailoredResume(
  resumeText: string,
  jdText: string,
  allowEmbellish: boolean,
): Promise<JobHunterResult> {
  const client = getClient(TIMEOUT_MS);
  try {
    return await callModel(client, resumeText, jdText, allowEmbellish, false);
  } catch (err) {
    if (err instanceof SchemaValidationError || isZodError(err)) {
      return await callModel(client, resumeText, jdText, allowEmbellish, true);
    }
    throw err;
  }
}
