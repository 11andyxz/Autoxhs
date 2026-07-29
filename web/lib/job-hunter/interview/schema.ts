import { z } from "zod";

import { normalizeCode } from "./typing";

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
        "一整套面试题库,10~12 道,严格基于候选人简历里的真实技能/项目/领域出题。以技术题为主(约 75~80%:概念 concept / 场景 scenario / 系统设计 system-design),仅含少量行为面试(behavioral, STAR)题(约 2~3 道)。",
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
              "面试题本身(只给候选人看的题干)。技术题锚定简历里的具体技能/项目/技术栈;行为题像面试官提问并锚定某段真实经历,如 'Tell me about a time on <该项目> when…'。",
          },
          referenceAnswer: {
            type: "string",
            description:
              "精炼的参考答案(要点/短提纲,别写长篇),作为评分基准。技术题给出正确要点;行为题按 STAR 给出简短框架并引用简历里的真实经历。",
          },
          rubric: {
            type: "array",
            description: "3~6 条评分要点,每条带相对权重。技术题覆盖正确性/完整性/权衡;行为题覆盖 STAR 完整度、具体性/量化、个人贡献。",
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

/** 中英双语文本(评分反馈都用它,便于英文面试备考同时看中英) */
export const BiTextSchema = z.object({
  zh: z.string(),
  en: z.string(),
});
export type BiText = z.infer<typeof BiTextSchema>;

export const CriterionScoreSchema = z.object({
  criterion: z.string(),
  score: z.number(), // 0~100
  comment: z.string(), // 中文点评
  commentEn: z.string(), // 同一条点评的英文版
});
export const GradeSchema = z.object({
  total: z.number(), // 0~100
  criteria: z.array(CriterionScoreSchema),
  hits: z.array(BiTextSchema),
  misses: z.array(BiTextSchema),
  errors: z.array(BiTextSchema),
  advice: z.array(BiTextSchema),
});
export type Grade = z.infer<typeof GradeSchema>;

const BI_TEXT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    zh: { type: "string", description: "简体中文版" },
    en: { type: "string", description: "同一条内容的英文版(意思一致)" },
  },
  required: ["zh", "en"],
} as const;

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
          comment: { type: "string", description: "简短点评(简体中文)" },
          commentEn: { type: "string", description: "同一条点评的英文版" },
        },
        required: ["criterion", "score", "comment", "commentEn"],
      },
    },
    hits: { type: "array", description: "答对/覆盖到的要点(中英双语)", items: BI_TEXT_JSON_SCHEMA },
    misses: { type: "array", description: "遗漏的要点(中英双语)", items: BI_TEXT_JSON_SCHEMA },
    errors: { type: "array", description: "答错/概念错误(中英双语)", items: BI_TEXT_JSON_SCHEMA },
    advice: { type: "array", description: "针对性改进建议(中英双语)", items: BI_TEXT_JSON_SCHEMA },
  },
  required: ["total", "criteria", "hits", "misses", "errors", "advice"],
} as const;

/* ---------------- 划词翻译(阅读英文时查词)---------------- */

export const TRANSLATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    en: {
      type: "string",
      description:
        "这个词/符号在英文里怎么读出来:普通单词/短语就是它本身;符号/标点/运算符给它常见的英文读法名称,如 '(' → 'left parenthesis'、'=>' → 'arrow'、'&&' → 'logical AND'、'!=' → 'not equal'",
    },
    ipa: {
      type: "string",
      description:
        "上面 en 的国际音标(IPA)注音,含两侧斜杠,如 /lɛft pəˈrɛnθəsɪs/;短语/多词给整体注音(词间空格分隔)。始终给出,不要留空",
    },
    zh: { type: "string", description: "该英文词/短语/符号在此语境下的简体中文意思(简短)" },
    note: { type: "string", description: "一行简短中文说明(词性/语境细微差别),可为空" },
  },
  required: ["en", "ipa", "zh", "note"],
} as const;

/* ---------------- 单词本例句 ---------------- */

export const VOCAB_EXAMPLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    example: {
      type: "string",
      description: "一句纯英文例句(tech/面试语境,自然、不太长);必须全英文,不得含任何中文或原始非英文写法",
    },
    en: { type: "string", description: "例句里实际使用的英文单词/短语(原形,用于高亮/发音)" },
    exampleZh: { type: "string", description: "该例句的简体中文翻译" },
    demo: {
      type: "string",
      description:
        "一个简单明了的例子:优先给最小可运行的代码片段(≤6行,选最贴切的语言 SQL/Java/JS/TS/HTTP/YAML/shell 等)演示该词/概念;不适合代码时给极简具体示例(如一行请求/响应)。纯代码/示例本身,别加解释文字,别用 markdown 反引号围栏。",
    },
    demoNote: { type: "string", description: "一句简体中文说明这个例子在演示什么/要注意的点(可空)" },
  },
  required: ["example", "en", "exampleZh", "demo", "demoNote"],
} as const;

/** 只补「例子」(demo)——给旧词回填,不动已有例句。 */
export const VOCAB_DEMO_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    demo: {
      type: "string",
      description:
        "一个简单明了的例子:优先给最小可运行的代码片段(≤6行,选最贴切的语言)演示该词/概念;不适合代码时给极简具体示例。纯代码/示例本身,别加解释文字,别用 markdown 反引号围栏。",
    },
    demoNote: { type: "string", description: "一句简体中文说明这个例子在演示什么(可空)" },
  },
  required: ["demo", "demoNote"],
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

/** 清洗中英双语列表:各项 trim+截断,zh/en 至少一个非空才保留 */
function cleanBiList(arr: BiText[], cap: number, itemLen: number): BiText[] {
  return arr
    .map((x) => ({ zh: t(x.zh, itemLen), en: t(x.en, itemLen) }))
    .filter((x) => x.zh || x.en)
    .slice(0, cap);
}

export function normalizeGrade(input: unknown): Grade {
  const parsed = GradeSchema.parse(input);
  return {
    total: clamp100(parsed.total),
    criteria: parsed.criteria
      .map((c) => ({
        criterion: t(c.criterion, 500),
        score: clamp100(c.score),
        comment: t(c.comment, 1000),
        commentEn: t(c.commentEn, 1000),
      }))
      .filter((c) => c.criterion)
      .slice(0, 10),
    hits: cleanBiList(parsed.hits, 20, 600),
    misses: cleanBiList(parsed.misses, 20, 600),
    errors: cleanBiList(parsed.errors, 20, 600),
    advice: cleanBiList(parsed.advice, 12, 800),
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

/* ---------------- 讲解「附加料」:面试关键词 + SVG 示意图 + 生图计划 ---------------- */

export const MAX_KEYWORDS = 12;
// 绝对上限(normalize 切片用);实际每次生成的目标张数按环境注入(本地多、Vercel 压 60s 内)。
export const MAX_DIAGRAMS = 12;

export const EXPLAIN_EXTRAS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    keywords: {
      type: "array",
      description: "面试官最想听到的英文术语/加分词(6~12 个)",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          term: { type: "string", description: "面试里该说出口的英文术语/短语" },
          note: { type: "string", description: "一句中文小注:何时/为何用它" },
        },
        required: ["term", "note"],
      },
    },
    diagrams: {
      type: "array",
      description: "自包含 SVG 技术示意图:每个子概念一张、覆盖完整、精简(文字清晰、无 script/外链);张数上限见 DIAGRAM BUDGET",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          svg: { type: "string", description: "自包含 <svg viewBox=…>…</svg>,内联、无脚本/外链、文字拼写正确、简洁易读" },
          caption: { type: "string", description: "中文说明" },
        },
        required: ["svg", "caption"],
      },
    },
  },
  required: ["keywords", "diagrams"],
} as const;

export type ExplainKeyword = { term: string; note: string };
export type ExplainDiagram = { svg: string; caption: string };
export type ExplainExtras = {
  keywords: ExplainKeyword[];
  diagrams: ExplainDiagram[];
};

/**
 * SVG 只保留安全子集:必须是 <svg>…</svg>,去掉 script/事件处理器/foreignObject/危险链接。
 * 前端仍用 <img data-uri> 二次隔离(img 里的 SVG 不执行脚本)。
 */
export function sanitizeSvg(svg: string): string {
  let s = (svg || "").trim();
  const start = s.indexOf("<svg");
  const end = s.lastIndexOf("</svg>");
  if (start < 0 || end < 0) return "";
  s = s.slice(start, end + 6);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/(xlink:href|href)\s*=\s*("|')\s*(?:javascript:|data:text\/html)[^"']*("|')/gi, '$1="#"');
  return s.slice(0, 20000);
}

/** 抽出 SVG 里各 <text> 元素的文字(用 · 连接):供「图中文字划词翻译」+ 追问时给 AI 当上下文。 */
export function extractSvgText(svg: string): string {
  const parts: string[] = [];
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const inner = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (inner) parts.push(inner);
  }
  // 去掉相邻重复(有些 SVG 会重复标签),保序
  const seen = new Set<string>();
  const uniq = parts.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return uniq.join(" · ").slice(0, 2000);
}

export function normalizeExplainExtras(raw: unknown): ExplainExtras {
  const o = (raw ?? {}) as { keywords?: unknown; diagrams?: unknown };
  const keywords = (Array.isArray(o.keywords) ? o.keywords : [])
    .map((k) => k as { term?: unknown; note?: unknown })
    .filter((k) => typeof k.term === "string" && k.term.trim())
    .map((k) => ({ term: t(String(k.term), 80), note: t(typeof k.note === "string" ? k.note : "", 140) }))
    .slice(0, MAX_KEYWORDS);
  const diagrams = (Array.isArray(o.diagrams) ? o.diagrams : [])
    .map((d) => d as { svg?: unknown; caption?: unknown })
    .map((d) => ({
      svg: sanitizeSvg(typeof d.svg === "string" ? d.svg : ""),
      caption: t(typeof d.caption === "string" ? d.caption : "", 200),
    }))
    .filter((d) => d.svg)
    .slice(0, MAX_DIAGRAMS);
  return { keywords, diagrams };
}

/* ---------------- 简历猛攻:把选中的一大段简历/面试稿 → SVG 记忆卡片(只出图,不出关键词) ---------------- */

export const CRAM_CARDS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    diagrams: {
      type: "array",
      description: "自包含 SVG 记忆卡片(结构/数字/关键词等,视这段内容而定);覆盖完整、精简;张数上限见 CARD BUDGET",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          svg: { type: "string", description: "自包含 <svg viewBox=…>…</svg>,内联、无脚本/外链、文字拼写正确、简洁易读" },
          caption: { type: "string", description: "中文说明:这张卡帮你记住什么" },
        },
        required: ["svg", "caption"],
      },
    },
  },
  required: ["diagrams"],
} as const;

export type CramCards = { diagrams: ExplainDiagram[] };

export function normalizeCramCards(raw: unknown): CramCards {
  const o = (raw ?? {}) as { diagrams?: unknown };
  const diagrams = (Array.isArray(o.diagrams) ? o.diagrams : [])
    .map((d) => d as { svg?: unknown; caption?: unknown })
    .map((d) => ({
      svg: sanitizeSvg(typeof d.svg === "string" ? d.svg : ""),
      caption: t(typeof d.caption === "string" ? d.caption : "", 200),
    }))
    .filter((d) => d.svg)
    .slice(0, MAX_DIAGRAMS);
  if (!diagrams.length) throw new SchemaValidationError("没有生成有效的记忆卡片");
  return { diagrams };
}

/* ---------------- 跟打题「断点」:逐步拆解每个片段返回什么(类型 + 示例值) ---------------- */

export const CODING_TRACE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sampleInput: {
      type: "string",
      description: "一小份示例输入数据(2~6 行,尽量短),让下面每一步的示例值有据可依。纯文本,可用简写。",
    },
    steps: {
      type: "array",
      description: "按「求值顺序」逐步拆解,4~10 步:从最内层的表达式一路算到最终结果。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          snippet: {
            type: "string",
            description:
              "这一步对应的代码片段,必须逐字来自参考代码(原样复制,不要改空格/大小写),这样才能在代码里高亮出来。",
          },
          type: {
            type: "string",
            description:
              "这一步的返回类型。Java 写完整泛型(如 Stream<User>、Collector<User, ?, Map<String, Long>>、Function<User, String>);SQL/Mongo 写中间结果的形状(如 结果集(dept, salary) / 文档 {_id, total})。",
          },
          value: {
            type: "string",
            description: "按示例输入算出的这一步的值(短,一行以内;集合类只举 2~3 个元素,可用 … 省略)。",
          },
          note: { type: "string", description: "一句中文说明:这一步在干什么 / 为什么是这个类型。" },
        },
        required: ["snippet", "type", "value", "note"],
      },
    },
  },
  required: ["sampleInput", "steps"],
} as const;

export type CodingTraceStep = { snippet: string; type: string; value: string; note: string };
export type CodingTrace = { sampleInput: string; steps: CodingTraceStep[] };

const MAX_TRACE_STEPS = 12;

export function normalizeCodingTrace(raw: unknown): CodingTrace {
  const o = (raw ?? {}) as { sampleInput?: unknown; steps?: unknown };
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map((s) => s as { snippet?: unknown; type?: unknown; value?: unknown; note?: unknown })
    .map((s) => ({
      snippet: typeof s.snippet === "string" ? s.snippet.replace(/\r\n?/g, "\n").trim().slice(0, 400) : "",
      type: t(typeof s.type === "string" ? s.type : "", 200),
      value: t(typeof s.value === "string" ? s.value : "", 300),
      note: t(typeof s.note === "string" ? s.note : "", 300),
    }))
    .filter((s) => s.snippet && s.type)
    .slice(0, MAX_TRACE_STEPS);
  if (!steps.length) throw new SchemaValidationError("没有拆解出有效的步骤");
  return {
    sampleInput: typeof o.sampleInput === "string" ? o.sampleInput.trim().slice(0, 1000) : "",
    steps,
  };
}

/* ---------------- AI 校对润色:改语法 + 事实核查纠错,返回改后文本 + 纠正清单 ---------------- */

export const REFINE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    refined: { type: "string", description: "改好的答案:修语法 + 纠正明显的事实/技术错误,不扩写、保留原语言与结构" },
    notes: {
      type: "array",
      description: "事实/技术层面的纠正或存疑点(中文短句);纯语法改动不列;没有则空数组",
      items: { type: "string" },
    },
  },
  required: ["refined", "notes"],
} as const;

export type RefineResult = { refined: string; notes: string[] };

export function normalizeRefine(raw: unknown): RefineResult {
  const o = (raw ?? {}) as { refined?: unknown; notes?: unknown };
  const refined = typeof o.refined === "string" ? o.refined.trim().slice(0, 8000) : "";
  if (!refined) throw new SchemaValidationError("润色结果为空");
  const notes = (Array.isArray(o.notes) ? o.notes : [])
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => t(n, 300))
    .slice(0, 12);
  return { refined, notes };
}

/* ---------------- Coding 跟打题:AI 出一批经典题(Java Lambda / MySQL / MongoDB / 算法) ---------------- */

export const CODING_CATEGORY_VALUES = ["java-lambda", "mysql", "mongodb", "design", "algorithm"] as const;
export const CODING_LANG_VALUES = ["java", "sql", "javascript"] as const;

export const CODING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    problems: {
      type: "array",
      description: "本次生成的题目;数量见 REQUESTED COUNT,不要重复已有题目",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: CODING_CATEGORY_VALUES as unknown as string[],
            description: "题目分类",
          },
          lang: {
            type: "string",
            enum: CODING_LANG_VALUES as unknown as string[],
            description: "参考代码的语言:java / sql / javascript(mongo shell)",
          },
          title: { type: "string", description: "中文短标题,点名考的技术点,不与已有题目重复" },
          prompt: { type: "string", description: "中文题干:1~2 句说清要做什么" },
          promptEn: { type: "string", description: "同一道题的英文题干(面试口径的英文表述,不是逐字翻译腔)" },
          setup: { type: "string", description: "给定上下文:建表语句 / 集合结构 / 类签名 / 已有变量;可为空串" },
          solution: {
            type: "string",
            description: "参考代码本体(要被逐字敲出来):4~22 行、每行 ≤80 字符、4 空格缩进、纯 ASCII、无代码围栏",
          },
          explanation: { type: "string", description: "中文要点:1~2 句讲关键点或经典追问/坑" },
          difficulty: { type: "integer", description: "难度 1 简单 / 2 中等 / 3 偏难" },
        },
        required: ["category", "lang", "title", "prompt", "promptEn", "setup", "solution", "explanation", "difficulty"],
      },
    },
  },
  required: ["problems"],
} as const;

export type CodingProblemGen = {
  category: (typeof CODING_CATEGORY_VALUES)[number];
  lang: (typeof CODING_LANG_VALUES)[number];
  title: string;
  prompt: string;
  promptEn: string;
  setup: string;
  solution: string;
  explanation: string;
  difficulty: number;
};

const MAX_CODING_PROBLEMS = 12;

export function normalizeCodingProblems(raw: unknown): { problems: CodingProblemGen[] } {
  const o = (raw ?? {}) as { problems?: unknown };
  const seen = new Set<string>();
  const problems = (Array.isArray(o.problems) ? o.problems : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => {
      const category = (CODING_CATEGORY_VALUES as readonly string[]).includes(p.category as string)
        ? (p.category as CodingProblemGen["category"])
        : "algorithm";
      const lang = (CODING_LANG_VALUES as readonly string[]).includes(p.lang as string)
        ? (p.lang as CodingProblemGen["lang"])
        : category === "mysql"
          ? "sql"
          : category === "mongodb"
            ? "javascript"
            : "java";
      return {
        category,
        lang,
        title: t(typeof p.title === "string" ? p.title : "", 120),
        prompt: t(typeof p.prompt === "string" ? p.prompt : "", 1500),
        promptEn: t(typeof p.promptEn === "string" ? p.promptEn : "", 1500),
        setup: t(typeof p.setup === "string" ? p.setup : "", 1500),
        // 跟打的目标文本必须先归一化(去围栏 / 展开 Tab / 中文标点换回 ASCII),否则有些字符根本敲不出来。
        solution: normalizeCode(typeof p.solution === "string" ? p.solution : ""),
        explanation: t(typeof p.explanation === "string" ? p.explanation : "", 1000),
        difficulty: Number.isFinite(Number(p.difficulty))
          ? Math.max(1, Math.min(3, Math.round(Number(p.difficulty))))
          : 2,
      };
    })
    .filter((p) => {
      if (!p.title || !p.prompt || !p.solution) return false;
      const key = `${p.category}|${p.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CODING_PROBLEMS);
  if (!problems.length) throw new SchemaValidationError("没有生成有效的题目");
  return { problems };
}

/* ---------------- 自定义题:用户给一道面试题,AI 生成参考答案 + 分类 ---------------- */

export const CUSTOM_ANSWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["concept", "scenario", "system-design", "behavioral"], description: "题型分类" },
    skill: { type: "string", description: "这道题考的核心技能/技术/主题(短,如 Kafka / System Design / Ownership)" },
    category: { type: "string", description: "所属领域(Backend / Database / Frontend / DevOps / Behavioral / System Design 等)" },
    importance: { type: "integer", description: "该主题对面试的重要度 1~5" },
    referenceAnswer: { type: "string", description: "标准、正确、够全面的参考答案:精炼提纲/要点,不写长篇;行为题给 STAR 范例。面试语言(默认英文)" },
    rubric: {
      type: "array",
      description: "3~5 个采分点(优秀答案必须命中)",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterion: { type: "string" },
          weight: { type: "number" },
        },
        required: ["criterion", "weight"],
      },
    },
  },
  required: ["type", "skill", "category", "importance", "referenceAnswer", "rubric"],
} as const;

export type CustomAnswer = {
  type: QuestionType;
  skill: string;
  category: string;
  importance: number;
  referenceAnswer: string;
  rubric: Array<{ criterion: string; weight: number }>;
};

export function normalizeCustomAnswer(raw: unknown): CustomAnswer {
  const o = (raw ?? {}) as {
    type?: unknown;
    skill?: unknown;
    category?: unknown;
    importance?: unknown;
    referenceAnswer?: unknown;
    rubric?: unknown;
  };
  const type = (QUESTION_TYPES as readonly string[]).includes(o.type as string)
    ? (o.type as QuestionType)
    : "concept";
  const referenceAnswer = typeof o.referenceAnswer === "string" ? o.referenceAnswer.trim().slice(0, 6000) : "";
  if (!referenceAnswer) throw new SchemaValidationError("参考答案为空");
  const rubric = (Array.isArray(o.rubric) ? o.rubric : [])
    .map((r) => r as { criterion?: unknown; weight?: unknown })
    .filter((r) => typeof r.criterion === "string" && r.criterion.trim())
    .map((r) => ({
      criterion: t(String(r.criterion), 300),
      weight: Number.isFinite(Number(r.weight)) ? Math.max(0, Math.min(100, Number(r.weight))) : 1,
    }))
    .slice(0, 8);
  return {
    type,
    skill: t(typeof o.skill === "string" ? o.skill : "", 120) || "General",
    category: t(typeof o.category === "string" ? o.category : "", 100) || "General",
    importance: clampImportance(Number(o.importance)),
    referenceAnswer,
    rubric: rubric.length ? rubric : [{ criterion: "覆盖题目核心要点", weight: 1 }],
  };
}
