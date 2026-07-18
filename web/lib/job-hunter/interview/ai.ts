import { getClient, getModel } from "@/lib/openai";

import {
  BANK_SYSTEM,
  COACH_SYSTEM,
  CRAM_ASK_SYSTEM,
  CRAM_CARDS_SYSTEM,
  CUSTOM_ANSWER_SYSTEM,
  DIAGRAM_ASK_SYSTEM,
  VOCAB_ASK_SYSTEM,
  EXPLAIN_EXTRAS_SYSTEM,
  EXPLAIN_SYSTEM,
  ENGLISH_ANSWER_SYSTEM,
  FUNDAMENTALS_SYSTEM,
  GRADE_SYSTEM,
  QUESTION_SYSTEM,
  REPAIR,
  SKILLS_SYSTEM,
  TRANSLATE_SYSTEM,
  VOCAB_DEMO_SYSTEM,
  VOCAB_EXAMPLE_SYSTEM,
  dataBlock,
} from "./prompt";
import {
  BANK_JSON_SCHEMA,
  COACH_JSON_SCHEMA,
  CRAM_CARDS_JSON_SCHEMA,
  CUSTOM_ANSWER_JSON_SCHEMA,
  EXPLAIN_EXTRAS_JSON_SCHEMA,
  GRADE_JSON_SCHEMA,
  QUESTION_JSON_SCHEMA,
  SKILLS_JSON_SCHEMA,
  TRANSLATE_JSON_SCHEMA,
  VOCAB_DEMO_JSON_SCHEMA,
  VOCAB_EXAMPLE_JSON_SCHEMA,
  SchemaValidationError,
  normalizeBank,
  normalizeCoach,
  normalizeCramCards,
  normalizeCustomAnswer,
  normalizeExplainExtras,
  normalizeGrade,
  normalizeQuestion,
  normalizeSkills,
  type BankResult,
  type Coach,
  type CramCards,
  type CustomAnswer,
  type ExplainExtras,
  type Grade,
  type QuestionGen,
  type QuestionType,
  type SkillsResult,
} from "./schema";

const TIMEOUT_MS = 90_000;

function isZodError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: string }).name === "ZodError";
}

/** 兜底:模型偶尔仍把代码用 ```lang ... ``` 围栏包起来,渲染成代码块时不需要,去掉。 */
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/** 通用:结构化 JSON 调用,仅在格式/校验错误时自动重试一次 */
async function callJson<T>(
  system: string,
  userContent: string,
  jsonSchema: Record<string, unknown>,
  schemaName: string,
  normalize: (raw: unknown) => T,
  opts: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<T> {
  // timeoutMs 视为两次尝试(初次 + 一次修复重试)的「总」预算:修复只用剩余时间,
  // 避免两次各占满 timeout 把 wall-clock 翻倍、冲破路由 maxDuration。
  const budgetMs = opts.timeoutMs ?? TIMEOUT_MS;
  const startedAt = Date.now();
  const run = async (repair: boolean, clientTimeoutMs: number): Promise<T> => {
    const client = getClient(clientTimeoutMs, opts.maxRetries ?? 1);
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
    return await run(false, budgetMs);
  } catch (err) {
    if (err instanceof SchemaValidationError || isZodError(err)) {
      const remaining = Math.max(8000, budgetMs - (Date.now() - startedAt));
      return await run(true, remaining);
    }
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
  // 题库是一次性重输出调用:给足单次超时(120s),并关掉 SDK 自动重试——
  // 否则超时后会再跑一次,等待翻倍到 ~4 分钟。宁可一次失败、快速反馈。
  return callJson(
    BANK_SYSTEM,
    content,
    BANK_JSON_SCHEMA as unknown as Record<string, unknown>,
    "bank",
    normalizeBank,
    { timeoutMs: 120_000, maxRetries: 0 },
  );
}

/** 2c) 生成「技术八股文」(纯 concept 概念题)。传 topics 则只按指定技术出,否则按简历技术栈。 */
export function buildFundamentals(args: {
  resumeText: string;
  jdText: string;
  topics?: string;
}): Promise<BankResult> {
  const content = dataBlock([
    { label: "REQUESTED TOPICS (if present, generate ONLY for these)", body: args.topics || "" },
    { label: "CANDIDATE RESUME (tech stack source / depth calibration)", body: args.resumeText },
    { label: "TARGET JOB DESCRIPTION (optional)", body: args.jdText },
  ]);
  return callJson(
    FUNDAMENTALS_SYSTEM,
    content,
    BANK_JSON_SCHEMA as unknown as Record<string, unknown>,
    "fundamentals",
    normalizeBank,
    { timeoutMs: 120_000, maxRetries: 0 },
  );
}

/** 用户给一道面试题 → 生成参考答案 + 分类(加入题库用)。 */
export function answerCustomQuestion(args: {
  question: string;
  resumeText: string;
  jdText: string;
}): Promise<CustomAnswer> {
  const content = dataBlock([
    { label: "QUESTION (the interview question to answer + classify)", body: args.question },
    { label: "CANDIDATE RESUME (depth calibration, optional)", body: args.resumeText },
    { label: "TARGET JOB DESCRIPTION (optional)", body: args.jdText },
  ]);
  return callJson(
    CUSTOM_ANSWER_SYSTEM,
    content,
    CUSTOM_ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
    "custom_answer",
    normalizeCustomAnswer,
    { timeoutMs: 52_000, maxRetries: 0 }, // 初次+修复共用此预算,给路由后续 DB 调用留头(maxDuration 60)
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

/** 针对「某一道具体题目」生成讲解(不是技能层面的泛讲):点「不会」时用。 */
export function explainQuestion(args: {
  language: string;
  question: string;
  referenceAnswer: string;
  kbExcerpts: string[];
}): Promise<Coach> {
  const content = dataBlock([
    { label: "INTERVIEW LANGUAGE", body: args.language },
    { label: "QUESTION (explain THIS exact question)", body: args.question },
    { label: "REFERENCE ANSWER (outline, may build on it)", body: args.referenceAnswer },
    { label: "KNOWLEDGE BASE EXCERPTS", body: args.kbExcerpts.join("\n\n---\n\n") },
  ]);
  return callJson(
    EXPLAIN_SYSTEM,
    content,
    COACH_JSON_SCHEMA as unknown as Record<string, unknown>,
    "explain",
    normalizeCoach,
  );
}

// Vercel 有 60s 函数上限;本地 next dev 没有。本地/线上共用同一 Aiven 库,
// 所以本地可以多生成 SVG(更长超时),存库后线上直接读库、不受 60s 限制。
const ON_VERCEL = !!process.env.VERCEL;
const EXTRAS_MAX_DIAGRAMS = ON_VERCEL ? 6 : 12; // 上限见 schema.MAX_DIAGRAMS=12
const EXTRAS_TIMEOUT_MS = ON_VERCEL ? 55_000 : 200_000;

/** 讲解的「附加料」:面试官爱听的关键词 + SVG 示意图(一次文本调用)。张数按环境注入。 */
export function generateExplainExtras(args: {
  question: string;
  lesson: string;
  modelAnswer: string;
}): Promise<ExplainExtras> {
  const content = dataBlock([
    { label: "QUESTION", body: args.question },
    { label: "EXPLANATION (lesson)", body: args.lesson },
    { label: "MODEL ANSWER", body: args.modelAnswer },
  ]);
  // 「张数预算」是开发者指令,放系统提示(可信),不放 DATA 块。
  const system = `${EXPLAIN_EXTRAS_SYSTEM}\n\nDIAGRAM BUDGET: produce up to ${EXTRAS_MAX_DIAGRAMS} diagrams — as many as it takes to give ONE per sub-concept and cover the whole topic (fewer is fine only if the topic genuinely has fewer sub-concepts). Keep each SVG concise.`;
  return callJson(
    system,
    content,
    EXPLAIN_EXTRAS_JSON_SCHEMA as unknown as Record<string, unknown>,
    "explain_extras",
    normalizeExplainExtras,
    { timeoutMs: EXTRAS_TIMEOUT_MS, maxRetries: 0 }, // 本地 200s / Vercel 55s(压在 60s 内)
  );
}

// 简历猛攻的「生成记忆卡片」:一次文本调用,把选中的一大段简历/面试稿变成若干 SVG 记忆卡。
// 与讲解附加料同口径:本地多张/长超时,Vercel 压 60s 内(共用同一 Aiven 库,本地生成存库线上直接读)。
const CRAM_MAX_CARDS = ON_VERCEL ? 4 : 6;
const CRAM_TIMEOUT_MS = ON_VERCEL ? 55_000 : 180_000;

/** 把选中的一段简历/面试稿 → 若干 SVG 记忆卡片(结构/数字/关键词),帮助脱稿背诵。 */
export function generateResumeCards(args: { passage: string; context: string }): Promise<CramCards> {
  const content = dataBlock([
    { label: "SELECTED PASSAGE (turn THIS into memory cards)", body: args.passage },
    { label: "DOCUMENT CONTEXT (surrounding text, for grounding only)", body: args.context },
  ]);
  // 「张数预算」是开发者指令,放系统提示(可信),不放 DATA 块。
  const system = `${CRAM_CARDS_SYSTEM}\n\nCARD BUDGET: produce up to ${CRAM_MAX_CARDS} cards — as many as it takes to cover the passage so it can be reconstructed from memory (fewer is fine for a short passage). Keep each SVG concise.`;
  return callJson(
    system,
    content,
    CRAM_CARDS_JSON_SCHEMA as unknown as Record<string, unknown>,
    "cram_cards",
    normalizeCramCards,
    { timeoutMs: CRAM_TIMEOUT_MS, maxRetries: 0 },
  );
}

/** 简历猛攻的「追问这段」:据选中段落 + 文档上下文,回答候选人的问题(中文、简洁)。返回纯文本。 */
export async function answerAboutResume(args: {
  passage: string;
  context: string;
  question: string;
}): Promise<string> {
  // 压在路由 maxDuration=60 内。
  const client = getClient(52_000);
  const content = dataBlock([
    { label: "SELECTED PASSAGE", body: args.passage },
    { label: "DOCUMENT CONTEXT", body: args.context },
    { label: "QUESTION (the candidate's question about this passage)", body: args.question },
  ]);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: CRAM_ASK_SYSTEM },
      { role: "user", content },
    ],
  });
  const text = (response.output_text ?? "").trim();
  if (!text) throw new SchemaValidationError("回答为空");
  return text;
}

/** 「问一下这个词」:据某个单词/短语(释义/例句),回答候选人的问题(中文、简洁)。返回纯文本。 */
export async function answerAboutVocab(args: {
  term: string;
  zh: string;
  example: string;
  question: string;
}): Promise<string> {
  // 压在路由 maxDuration=60 内,让慢调用被客户端中止、走优雅报错,而不是被 Vercel 硬杀成 504。
  const client = getClient(52_000);
  const content = dataBlock([
    { label: "TERM", body: args.term },
    { label: "MEANING (Chinese)", body: args.zh },
    { label: "EXAMPLE SENTENCE", body: args.example },
    { label: "QUESTION (the candidate's question about this term)", body: args.question },
  ]);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: VOCAB_ASK_SYSTEM },
      { role: "user", content },
    ],
  });
  const text = (response.output_text ?? "").trim();
  if (!text) throw new SchemaValidationError("回答为空");
  return text;
}

/** 「追问这张图」:据某张示意图(文字/说明)+讲解,回答候选人的追问(中文、简洁)。返回纯文本。 */
export async function answerAboutDiagram(args: {
  questionPrompt: string;
  diagramText: string;
  caption: string;
  lesson: string;
  followup: string;
}): Promise<string> {
  const client = getClient(TIMEOUT_MS);
  const content = dataBlock([
    { label: "INTERVIEW QUESTION", body: args.questionPrompt },
    { label: "DIAGRAM TEXT LABELS", body: args.diagramText },
    { label: "DIAGRAM CAPTION", body: args.caption },
    { label: "EXPLANATION (lesson)", body: args.lesson },
    { label: "FOLLOW-UP (the candidate's question about this diagram)", body: args.followup },
  ]);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: DIAGRAM_ASK_SYSTEM },
      { role: "user", content },
    ],
  });
  const text = (response.output_text ?? "").trim();
  if (!text) throw new SchemaValidationError("回答为空");
  return text;
}

/** 把候选人的作答(可中文/混合)改写成「面试可用的英文版作答」,保留其真实内容。 */
export async function polishToEnglish(args: {
  question: string;
  referenceAnswer: string;
  userAnswer: string;
}): Promise<string> {
  const client = getClient(TIMEOUT_MS);
  const content = dataBlock([
    { label: "INTERVIEW QUESTION", body: args.question },
    { label: "IDEAL ANSWER (reference only, do not copy verbatim)", body: args.referenceAnswer },
    { label: "CANDIDATE ANSWER (may be Chinese / mixed)", body: args.userAnswer },
  ]);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: ENGLISH_ANSWER_SYSTEM },
      { role: "user", content },
    ],
  });
  const text = (response.output_text ?? "").trim();
  if (!text) throw new SchemaValidationError("英文版生成为空");
  return text;
}

/** 划词翻译:把选中的英文词/短语,结合上下文解释成简体中文(含音标),查词用,输出很短、要快。 */
export function translateTerm(
  term: string,
  context: string,
): Promise<{ en: string; ipa: string; zh: string; note: string }> {
  const content = dataBlock([
    { label: "TERM (translate this only)", body: term },
    { label: "CONTEXT (where the term appears)", body: context },
  ]);
  return callJson(
    TRANSLATE_SYSTEM,
    content,
    TRANSLATE_JSON_SCHEMA as unknown as Record<string, unknown>,
    "translate",
    (raw) => {
      const o = (raw ?? {}) as { en?: unknown; ipa?: unknown; zh?: unknown; note?: unknown };
      const zh = typeof o.zh === "string" ? o.zh.trim().slice(0, 200) : "";
      if (!zh) throw new SchemaValidationError("翻译为空");
      return {
        en: typeof o.en === "string" ? o.en.trim().slice(0, 120) : "",
        ipa: typeof o.ipa === "string" ? o.ipa.trim().slice(0, 120) : "",
        zh,
        note: typeof o.note === "string" ? o.note.trim().slice(0, 300) : "",
      };
    },
    { timeoutMs: 30_000 },
  );
}

/** 为单词本生成一句 tech/面试语境的英文例句(+中文翻译),优先贴合提供的上下文。 */
export function generateVocabExample(
  term: string,
  en: string,
  zh: string,
  context: string,
): Promise<{ example: string; exampleZh: string; en: string; demo: string; demoNote: string }> {
  const content = dataBlock([
    { label: "TERM (as the learner saved it)", body: term },
    { label: "ENGLISH READING (how to say the term in English; may be empty)", body: en },
    { label: "TERM MEANING (Chinese)", body: zh },
    { label: "CONTEXT (where the learner saw it; may be empty)", body: context },
  ]);
  return callJson(
    VOCAB_EXAMPLE_SYSTEM,
    content,
    VOCAB_EXAMPLE_JSON_SCHEMA as unknown as Record<string, unknown>,
    "vocab_example",
    (raw) => {
      const o = (raw ?? {}) as {
        example?: unknown;
        en?: unknown;
        exampleZh?: unknown;
        demo?: unknown;
        demoNote?: unknown;
      };
      const example = typeof o.example === "string" ? o.example.trim().slice(0, 1000) : "";
      if (!example) throw new SchemaValidationError("例句为空");
      return {
        example,
        en: typeof o.en === "string" ? o.en.trim().slice(0, 255) : "",
        exampleZh: typeof o.exampleZh === "string" ? o.exampleZh.trim().slice(0, 1000) : "",
        demo: typeof o.demo === "string" ? stripFences(o.demo).slice(0, 1500) : "",
        demoNote: typeof o.demoNote === "string" ? o.demoNote.trim().slice(0, 500) : "",
      };
    },
    { timeoutMs: 30_000 },
  );
}

/** 只生成「例子」(demo,尽量是代码片段) —— 给已有例句的旧词回填,不动例句本身。 */
export function generateVocabDemo(
  term: string,
  en: string,
  zh: string,
  example: string,
): Promise<{ demo: string; demoNote: string }> {
  const content = dataBlock([
    { label: "TERM (as the learner saved it)", body: term },
    { label: "ENGLISH READING (may be empty)", body: en },
    { label: "TERM MEANING (Chinese)", body: zh },
    { label: "ENGLISH EXAMPLE SENTENCE already on the card", body: example },
  ]);
  return callJson(
    VOCAB_DEMO_SYSTEM,
    content,
    VOCAB_DEMO_JSON_SCHEMA as unknown as Record<string, unknown>,
    "vocab_demo",
    (raw) => {
      const o = (raw ?? {}) as { demo?: unknown; demoNote?: unknown };
      const demo = typeof o.demo === "string" ? stripFences(o.demo).slice(0, 1500) : "";
      if (!demo) throw new SchemaValidationError("例子为空");
      return { demo, demoNote: typeof o.demoNote === "string" ? o.demoNote.trim().slice(0, 500) : "" };
    },
    { timeoutMs: 30_000 },
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
