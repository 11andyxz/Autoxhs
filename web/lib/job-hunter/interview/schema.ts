import { z } from "zod";

/**
 * 专项面试训练(interview-prep)的结构化输出定义。
 * 四次模型调用各有一套 zod + JSON Schema:技能拆解 / 出题 / 评分 / 补强。
 */

export const QUESTION_TYPES = ["concept", "scenario", "system-design", "behavioral"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export class SchemaValidationError extends Error {}

/* ---------------- 1) 技能拆解 ---------------- */

// 注意:这些 schema 校验的是“模型输出”,不要用 .max() 硬性拒绝(否则模型多写几个字就 500)。
// 长度/数量上限统一在 normalize 里用截断/切片来保证。
export const SkillSchema = z.object({
  name: z.string(),
  category: z.string(),
  importance: z.number(), // 1~5
});
export const SkillsResultSchema = z.object({
  language: z.string(),
  skills: z.array(SkillSchema),
});
export type SkillItem = z.infer<typeof SkillSchema>;
export type SkillsResult = z.infer<typeof SkillsResultSchema>;

export const SKILLS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: "string", description: "面试问答应使用的语言,跟随 JD;英文 JD 用 English。" },
    skills: {
      type: "array",
      description: "从 JD 拆解出的可考核技能,8~16 个,按重要度排序。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "技能名,如 'Spring Boot'、'System Design'、'Behavioral'" },
          category: {
            type: "string",
            description: "分类,如 后端/前端/云原生/AI/数据库/系统设计/软技能",
          },
          importance: { type: "integer", description: "对该岗位的重要度 1~5(5 最高)" },
        },
        required: ["name", "category", "importance"],
      },
    },
  },
  required: ["language", "skills"],
} as const;

/* ---------------- 2) 出题 ---------------- */

export const RubricItemSchema = z.object({
  criterion: z.string(),
  weight: z.number(), // 相对权重
});
export const QuestionGenSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  prompt: z.string(),
  referenceAnswer: z.string(),
  rubric: z.array(RubricItemSchema),
});
export type QuestionGen = z.infer<typeof QuestionGenSchema>;

export const QUESTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: QUESTION_TYPES as unknown as string[],
      description: "题型:concept 概念/scenario 场景/system-design 系统设计/behavioral 行为(STAR)",
    },
    prompt: { type: "string", description: "面试题目本身(只给候选人看的题干)" },
    referenceAnswer: {
      type: "string",
      description: "理想参考答案,作为评分基准;要点完整、专业。",
    },
    rubric: {
      type: "array",
      description: "3~6 条评分要点,每条带相对权重。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterion: { type: "string", description: "评分维度/采分点" },
          weight: { type: "number", description: "相对权重,正数" },
        },
        required: ["criterion", "weight"],
      },
    },
  },
  required: ["type", "prompt", "referenceAnswer", "rubric"],
} as const;

/* ---------------- 2b) 一次性出一整套题库（面试官视角，重点行为面试 BQ） ---------------- */

export const BankQuestionSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  skill: z.string(), // 考核主题/能力项，如 "Ownership"、"Conflict"、"Spring Boot"
  category: z.string(), // 分类，如 Behavioral / 后端 / 系统设计
  importance: z.number(), // 1~5
  prompt: z.string(),
  referenceAnswer: z.string(),
  rubric: z.array(RubricItemSchema),
});
export const BankResultSchema = z.object({
  language: z.string(),
  questions: z.array(BankQuestionSchema),
});
export type BankQuestion = z.infer<typeof BankQuestionSchema>;
export type BankResult = z.infer<typeof BankResultSchema>;

export const BANK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: {
      type: "string",
      description: "面试问答应使用的语言,跟随简历/JD;英文简历用 English。",
    },
    questions: {
      type: "array",
      description:
        "一整套面试题库,10~16 道,严格基于候选人简历里的真实经历/项目/技能出题。以行为面试(behavioral, STAR)为主(至少 60%),辅以少量与简历技能相关的技术/概念/系统设计题。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: QUESTION_TYPES as unknown as string[],
            description: "题型:behavioral 行为(STAR)/concept 概念/scenario 场景/system-design 系统设计",
          },
          skill: {
            type: "string",
            description:
              "本题考核的主题或能力项。行为题用能力维度(如 Ownership/Leadership/Conflict/Ambiguity/Failure/Impact/Teamwork);技术题用简历里的具体技能名。",
          },
          category: {
            type: "string",
            description: "分类,如 Behavioral / 后端 / 前端 / 系统设计 / 数据库 / AI 等",
          },
          importance: { type: "integer", description: "该题对面试的重要度 1~5(5 最高)" },
          prompt: {
            type: "string",
            description:
              "面试题本身(只给候选人看的题干)。行为题要像面试官提问,并锚定简历里的某段具体经历/项目,如 'Tell me about a time on <该项目> when…'。",
          },
          referenceAnswer: {
            type: "string",
            description:
              "理想参考答案/答题框架,作为评分基准。行为题按 STAR(情境/任务/行动/结果)组织,并尽量引用简历里的该段真实经历与可量化成果。",
          },
          rubric: {
            type: "array",
            description: "3~6 条评分要点,每条带相对权重。行为题应覆盖 STAR 完整度、具体性/量化、个人贡献、复盘与收获。",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                criterion: { type: "string", description: "评分维度/采分点" },
                weight: { type: "number", description: "相对权重,正数" },
              },
              required: ["criterion", "weight"],
            },
          },
        },
        required: ["type", "skill", "category", "importance", "prompt", "referenceAnswer", "rubric"],
      },
    },
  },
  required: ["language", "questions"],
} as const;

/* ---------------- 3) 评分 ---------------- */

export const CriterionScoreSchema = z.object({
  criterion: z.string(),
  score: z.number(), // 0~100
  comment: z.string(),
});
export const GradeSchema = z.object({
  total: z.number(), // 0~100
  criteria: z.array(CriterionScoreSchema),
  hits: z.array(z.string()),
  misses: z.array(z.string()),
  errors: z.array(z.string()),
  advice: z.array(z.string()),
});
export type Grade = z.infer<typeof GradeSchema>;

export const GRADE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    total: { type: "integer", description: "总分 0~100,以参考答案/rubric/知识库为准客观评分。" },
    criteria: {
      type: "array",
      description: "按 rubric 的分项打分。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterion: { type: "string" },
          score: { type: "integer", description: "该维度 0~100" },
          comment: { type: "string", description: "简短点评(中文)" },
        },
        required: ["criterion", "score", "comment"],
      },
    },
    hits: { type: "array", description: "答对/覆盖到的要点(中文)", items: { type: "string" } },
    misses: { type: "array", description: "遗漏的要点(中文)", items: { type: "string" } },
    errors: { type: "array", description: "答错/概念错误(中文)", items: { type: "string" } },
    advice: { type: "array", description: "针对性改进建议(中文)", items: { type: "string" } },
  },
  required: ["total", "criteria", "hits", "misses", "errors", "advice"],
} as const;

/* ---------------- 4) 补强 ---------------- */

export const CoachSchema = z.object({
  lesson: z.string(),
  modelAnswer: z.string(),
  practiceQuestion: z.string(),
});
export type Coach = z.infer<typeof CoachSchema>;

export const COACH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lesson: { type: "string", description: "针对该技能弱点的微讲解(中文,分点,务实)。" },
    modelAnswer: { type: "string", description: "一个示范回答,展示如何答到位。" },
    practiceQuestion: { type: "string", description: "一道用于巩固的变式练习题(语言跟随面试语言)。" },
  },
  required: ["lesson", "modelAnswer", "practiceQuestion"],
} as const;

/* ---------------- normalize 辅助 ---------------- */

export function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
export function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}
/** 截断到 n 个字符(先 trim) */
function t(s: string, n: number): string {
  return s.trim().slice(0, n);
}
function cleanList(arr: string[], cap: number, itemLen: number): string[] {
  return arr.map((s) => t(s, itemLen)).filter(Boolean).slice(0, cap);
}

export function normalizeSkills(input: unknown): SkillsResult {
  const parsed = SkillsResultSchema.parse(input);
  const seen = new Set<string>();
  const skills = parsed.skills
    .map((s) => ({
      name: t(s.name, 255), // 对齐 ip_skill.name VARCHAR(255)
      category: t(s.category, 100) || "General", // 对齐 ip_skill.category VARCHAR(100)
      importance: clampImportance(s.importance),
    }))
    .filter((s) => {
      if (!s.name) return false;
      const k = s.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 40);
  if (!skills.length) throw new SchemaValidationError("未能拆解出技能");
  // 对齐 ip_session.language VARCHAR(50)
  return { language: t(parsed.language, 50) || "English", skills };
}

export function normalizeQuestion(input: unknown): QuestionGen {
  const parsed = QuestionGenSchema.parse(input);
  const prompt = t(parsed.prompt, 8000);
  if (!prompt) throw new SchemaValidationError("题干为空");
  const rubric = parsed.rubric
    .map((r) => ({
      criterion: t(r.criterion, 500),
      weight: Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1,
    }))
    .filter((r) => r.criterion)
    .slice(0, 8);
  return {
    type: parsed.type,
    prompt,
    referenceAnswer: t(parsed.referenceAnswer, 12000),
    rubric: rubric.length ? rubric : [{ criterion: "Correctness & completeness", weight: 1 }],
  };
}

export function normalizeGrade(input: unknown): Grade {
  const parsed = GradeSchema.parse(input);
  return {
    total: clamp100(parsed.total),
    criteria: parsed.criteria
      .map((c) => ({ criterion: t(c.criterion, 500), score: clamp100(c.score), comment: t(c.comment, 1000) }))
      .filter((c) => c.criterion)
      .slice(0, 10),
    hits: cleanList(parsed.hits, 20, 600),
    misses: cleanList(parsed.misses, 20, 600),
    errors: cleanList(parsed.errors, 20, 600),
    advice: cleanList(parsed.advice, 12, 800),
  };
}

export function normalizeCoach(input: unknown): Coach {
  const parsed = CoachSchema.parse(input);
  return {
    lesson: t(parsed.lesson, 8000),
    modelAnswer: t(parsed.modelAnswer, 6000),
    practiceQuestion: t(parsed.practiceQuestion, 3000),
  };
}

/** 出题题库上限:一次最多收录 24 道,防模型跑飞 */
const MAX_BANK_QUESTIONS = 24;

export function normalizeBank(input: unknown): BankResult {
  const parsed = BankResultSchema.parse(input);
  const seenPrompts = new Set<string>();
  const questions = parsed.questions
    .map((q) => {
      const rubric = q.rubric
        .map((r) => ({
          criterion: t(r.criterion, 500),
          weight: Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1,
        }))
        .filter((r) => r.criterion)
        .slice(0, 8);
      return {
        type: q.type,
        skill: t(q.skill, 255) || "General",
        category: t(q.category, 100) || "General",
        importance: clampImportance(q.importance),
        prompt: t(q.prompt, 8000),
        referenceAnswer: t(q.referenceAnswer, 12000),
        rubric: rubric.length ? rubric : [{ criterion: "Correctness & completeness", weight: 1 }],
      };
    })
    .filter((q) => {
      if (!q.prompt) return false;
      const k = q.prompt.toLowerCase();
      if (seenPrompts.has(k)) return false; // 去掉完全重复的题干
      seenPrompts.add(k);
      return true;
    })
    .slice(0, MAX_BANK_QUESTIONS);
  if (!questions.length) throw new SchemaValidationError("未能生成题库");
  // 对齐 ip_session.language VARCHAR(50)
  return { language: t(parsed.language, 50) || "English", questions };
}
