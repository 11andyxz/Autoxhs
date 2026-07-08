import { getClient, getModel } from "@/lib/openai";

/**
 * 用 AI 回答 Indeed 雇主资格/筛选问题(知识库未命中的兜底)。
 * 依据:用户的「求职身份档案」事实 + 可选的简历摘要 + 岗位信息。
 * 单选/多选题必须返回其中一个 option 的 value;硬事实缺失时给最保守答案并标 low。
 */

export type AiAnswerQuestion = {
  id: string;
  type: string;
  required: boolean;
  label: string;
  options: Array<{ value: string; label: string }> | null;
};

export type AiConfidence = "high" | "medium" | "low";
export type AiAnswer = { value: string; confidence: AiConfidence };

const SYSTEM = [
  "你是求职助手,替申请人如实回答 Indeed 雇主的资格 / 筛选问题。",
  "铁律:",
  "1. 只依据给定的「申请人事实」和「简历 / 岗位信息」作答,绝不编造与事实矛盾的内容。",
  "2. 选项题(带 options):value 必须原样等于其中某个 option 的 value,禁止自造字符串。",
  "3. 数字题只返回数字;文本题简短如实(英文岗位用英文答)。",
  "4. 工作授权 / sponsorship / 公民身份 / 学历 / 安全许可等硬事实:严格按「申请人事实」;",
  "   事实缺失又必须作答时,选与已知事实最不矛盾、最保守的答案,并把 confidence 标为 low。",
  "5. confidence:事实里直接有依据=high;从简历/岗位合理推断=medium;缺依据靠保守猜=low。",
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "value", "confidence"],
        properties: {
          questionId: { type: "string" },
          value: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

export type AiAnswerContext = {
  facts: string;
  jobTitle?: string;
  company?: string;
  resume?: string;
};

/** 返回 questionId -> {value, confidence};失败/未答的 question 不在结果里。 */
export async function aiAnswerQuestions(
  questions: AiAnswerQuestion[],
  ctx: AiAnswerContext,
): Promise<Record<string, AiAnswer>> {
  if (!questions.length) return {};
  const client = getClient();

  const userMsg = [
    "申请人事实:\n" + (ctx.facts.trim() || "(暂无档案事实)"),
    ctx.resume?.trim() ? "简历摘要:\n" + ctx.resume.trim().slice(0, 4000) : "",
    "目标岗位:" + ([ctx.jobTitle, ctx.company].filter(Boolean).join(" · ") || "(未知)"),
    "需要作答的问题(JSON 数组):\n" +
      JSON.stringify(
        questions.map((q) => ({
          questionId: q.id,
          type: q.type,
          required: q.required,
          label: q.label,
          options: q.options,
        })),
      ),
    "请逐题作答。选项题的 value 必须是该题某个 option 的 value。",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "indeed_ai_answers",
        strict: true,
        schema: SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const text = response.output_text;
  if (!text) return {};
  let parsed: { answers?: Array<{ questionId?: string; value?: string; confidence?: AiConfidence }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: Record<string, AiAnswer> = {};
  for (const a of parsed.answers ?? []) {
    const q = a.questionId ? byId.get(a.questionId) : undefined;
    if (!q) continue;
    let value = String(a.value ?? "");
    // 选项题:校验 value 合法,否则按 label 兜底匹配,再不行留空(交由复核处理,不瞎猜)。
    if (q.options && q.options.length) {
      if (!q.options.some((o) => o.value === value)) {
        const byLabel = q.options.find((o) => o.label.toLowerCase() === value.toLowerCase());
        value = byLabel ? byLabel.value : "";
      }
    }
    out[q.id] = { value, confidence: a.confidence ?? "low" };
  }
  return out;
}
