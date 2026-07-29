import type OpenAI from "openai";

import { getClient, getModel } from "@/lib/openai";

import {
  CODING_SYSTEM,
  SUMMARY_SYSTEM,
  buildAnswerSystem,
  buildAnswerUser,
  buildCodingUser,
  buildSummaryUser,
} from "./prompt";
import { LIMITS, type AnswerRequest, type CodingRequest, type Profile, type Turn } from "./schema";
import type { QuestionKind } from "./question";

/**
 * 实时回答的模型调用层。全部走流式:面试里「第一个字多久出来」比「总共多久」重要得多,
 * 边出边读,用户不用等整段生成完。
 *
 * 推理强度固定 low(与 lib/job-hunter 的长输出调用同思路):实时场景宁可少想一点也要快。
 * 可用 AI_INTERVIEW_EFFORT 覆盖(medium/high),或设 off 完全不传该参数(换非推理模型时用)。
 */

const STREAM_TIMEOUT_MS = 90_000;

/** 回答用的模型;默认跟随全局 OPENAI_MODEL,可用 AI_INTERVIEW_MODEL 单独换成更快的。 */
export function answerModel(): string {
  return process.env.AI_INTERVIEW_MODEL || getModel();
}

/** 截屏解题用的多模态模型(默认与回答同一个) */
export function visionModel(): string {
  return process.env.AI_INTERVIEW_VISION_MODEL || answerModel();
}

type Effort = { reasoning: { effort: "low" | "medium" | "high" } } | Record<string, never>;

function effort(): Effort {
  const raw = (process.env.AI_INTERVIEW_EFFORT || "low").toLowerCase();
  if (raw === "off" || raw === "none") return {};
  if (raw === "medium" || raw === "high") return { reasoning: { effort: raw } };
  return { reasoning: { effort: "low" } };
}

type InputItem = OpenAI.Responses.ResponseInputItem;

/** 跑一次流式请求,把可见文字增量吐出来(推理增量不吐)。 */
async function* streamText(opts: {
  model: string;
  input: InputItem[];
  maxTokens: number;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const client = getClient(STREAM_TIMEOUT_MS, 0);
  const stream = await client.responses.create(
    {
      model: opts.model,
      ...effort(),
      input: opts.input,
      max_output_tokens: opts.maxTokens,
      stream: true,
    },
    { signal: opts.signal },
  );
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield event.delta;
    }
  }
}

/** 生成「我现在该说什么」。qKind 是规则判出的问题类型,只用来给模型一点倾向性提示。 */
export function streamAnswer(
  req: AnswerRequest,
  qKind?: QuestionKind,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  return streamText({
    model: answerModel(),
    input: [
      { role: "system", content: buildAnswerSystem(req.mode, req.style, req.lang, req.kind, qKind) },
      { role: "user", content: buildAnswerUser(req) },
    ],
    maxTokens: LIMITS.answerTokens,
    signal,
  });
}

/** 截屏解题:把屏幕上的题目图 + 听到的补充一起交给多模态模型。 */
export function streamCodingHint(req: CodingRequest, signal?: AbortSignal): AsyncGenerator<string> {
  return streamText({
    model: visionModel(),
    input: [
      { role: "system", content: CODING_SYSTEM },
      {
        role: "user",
        content: [
          { type: "input_text", text: buildCodingUser(req) },
          { type: "input_image", image_url: req.image, detail: "high" },
        ],
      },
    ],
    maxTokens: LIMITS.codingTokens,
    signal,
  });
}

/** 会后复盘:一次性生成(不流式),存库后在页面上展示 / 导出。 */
export async function summarizeSession(input: {
  turns: Turn[];
  profile: Pick<Profile, "jd" | "company">;
}): Promise<string> {
  const client = getClient(STREAM_TIMEOUT_MS, 0);
  const response = await client.responses.create({
    model: answerModel(),
    ...effort(),
    input: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: buildSummaryUser(input) },
    ],
    max_output_tokens: LIMITS.summaryTokens,
  });
  return (response.output_text ?? "").trim();
}
