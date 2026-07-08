import { getClient, getModel } from "@/lib/openai";

import {
  BANK_SYSTEM,
  COACH_SYSTEM,
  GRADE_SYSTEM,
  QUESTION_SYSTEM,
  REPAIR,
  SKILLS_SYSTEM,
  dataBlock,
} from "./prompt";
import {
  BANK_JSON_SCHEMA,
  COACH_JSON_SCHEMA,
  GRADE_JSON_SCHEMA,
  QUESTION_JSON_SCHEMA,
  SKILLS_JSON_SCHEMA,
  SchemaValidationError,
  normalizeBank,
  normalizeCoach,
  normalizeGrade,
  normalizeQuestion,
  normalizeSkills,
  type BankResult,
  type Coach,
  type Grade,
  type QuestionGen,
  type QuestionType,
  type SkillsResult,
} from "./schema";

const TIMEOUT_MS = 90_000;

function isZodError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "ZodError";
}

/** 通用:结构化 JSON 调用,仅在格式/校验错误时自动重试一次 */
async function callJson<T>(
  system: string,
  userContent: string,
  jsonSchema: Record<string, unknown>,
  schemaName: string,
  normalize: (raw: unknown) => T,
): Promise<T> {
  const client = getClient(TIMEOUT_MS);
  const run = async (repair: boolean): Promise<T> => {
    const input: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: system },
    ];
    if (repair) input.push({ role: "system", content: REPAIR });
    input.push({ role: "user", content: userContent });

    const response = await client.responses.create({
      model: getModel(),
      input,
      text: {
        format: { type: "json_schema", name: schemaName, strict: true, schema: jsonSchema },
      },
    });
    const text = response.output_text;
    if (!text) throw new SchemaValidationError("模型输出为空");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SchemaValidationError("模型输出不是合法 JSON");
    }
    return normalize(json);
  };

  try {
    return await run(false);
  } catch (err) {
    if (err instanceof SchemaValidationError || isZodError(err)) return await run(true);
    throw err;
  }
}

/** 1) 从简历+JD(+弱点)拆解技能 */
export function extractSkills(
  resumeText: string,
  jdText: string,
  weaknesses: string[],
): Promise<SkillsResult> {
  const content = dataBlock([
    { label: "JOB DESCRIPTION", body: jdText },
    { label: "CANDIDATE RESUME", body: resumeText },
    { label: "KNOWN GAPS (prioritize these)", body: weaknesses.join("\n") },
  ]);
  return callJson(
    SKILLS_SYSTEM,
    content,
    SKILLS_JSON_SCHEMA as unknown as Record<string, unknown>,
    "skills",
    normalizeSkills,
  );
}

/** 2) 针对某技能出题 */
export function generateQuestion(args: {
  language: string;
  skill: string;
  category: string;
  jdText: string;
  resumeText: string;
  kbExcerpts: string[];
  askedPrompts: string[];
  preferType?: QuestionType;
}): Promise<QuestionGen> {
  const content = dataBlock([
    { label: "INTERVIEW LANGUAGE", body: args.language },
    { label: "TARGET SKILL", body: `${args.skill} (category: ${args.category})` },
    { label: "PREFERRED QUESTION TYPE", body: args.preferType ?? "" },
    { label: "JOB DESCRIPTION", body: args.jdText },
    { label: "CANDIDATE RESUME", body: args.resumeText },
    { label: "KNOWLEDGE BASE EXCERPTS", body: args.kbExcerpts.join("\n\n---\n\n") },
    { label: "ALREADY ASKED (do not repeat)", body: args.askedPrompts.join("\n") },
  ]);
  return callJson(
    QUESTION_SYSTEM,
    content,
    QUESTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    "question",
    normalizeQuestion,
  );
}

/** 2b) 一次性生成整套「按简历定制」的面试题库(面试官视角,重点行为面试) */
export function buildQuestionBank(args: {
  resumeText: string;
  jdText: string;
  kbExcerpts: string[];
}): Promise<BankResult> {
  const content = dataBlock([
    { label: "CANDIDATE RESUME", body: args.resumeText },
    { label: "TARGET JOB DESCRIPTION (optional)", body: args.jdText },
    { label: "KNOWLEDGE BASE EXCERPTS", body: args.kbExcerpts.join("\n\n---\n\n") },
  ]);
  return callJson(
    BANK_SYSTEM,
    content,
    BANK_JSON_SCHEMA as unknown as Record<string, unknown>,
    "bank",
    normalizeBank,
  );
}

/** 3) 给答案评分 */
export function gradeAnswer(args: {
  question: string;
  referenceAnswer: string;
  rubric: Array<{ criterion: string; weight: number }>;
  answer: string;
  kbExcerpts: string[];
}): Promise<Grade> {
  const content = dataBlock([
    { label: "QUESTION", body: args.question },
    { label: "REFERENCE ANSWER (source of truth)", body: args.referenceAnswer },
    {
      label: "RUBRIC",
      body: args.rubric.map((r) => `- ${r.criterion} (weight ${r.weight})`).join("\n"),
    },
    { label: "KNOWLEDGE BASE EXCERPTS", body: args.kbExcerpts.join("\n\n---\n\n") },
    { label: "CANDIDATE ANSWER", body: args.answer },
  ]);
  return callJson(
    GRADE_SYSTEM,
    content,
    GRADE_JSON_SCHEMA as unknown as Record<string, unknown>,
    "grade",
    normalizeGrade,
  );
}

/** 4) 针对弱点补强 */
export function coachSkill(args: {
  language: string;
  skill: string;
  weaknesses: string[];
  jdText: string;
  kbExcerpts: string[];
}): Promise<Coach> {
  const content = dataBlock([
    { label: "INTERVIEW LANGUAGE", body: args.language },
    { label: "WEAK SKILL", body: args.skill },
    { label: "RECORDED WEAKNESSES", body: args.weaknesses.join("\n") },
    { label: "JOB DESCRIPTION", body: args.jdText },
    { label: "KNOWLEDGE BASE EXCERPTS", body: args.kbExcerpts.join("\n\n---\n\n") },
  ]);
  return callJson(
    COACH_SYSTEM,
    content,
    COACH_JSON_SCHEMA as unknown as Record<string, unknown>,
    "coach",
    normalizeCoach,
  );
}

/** 嵌入向量(知识库检索用)。返回每段文本的向量。 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const client = getClient(TIMEOUT_MS);
  const res = await client.embeddings.create({
    model: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}
