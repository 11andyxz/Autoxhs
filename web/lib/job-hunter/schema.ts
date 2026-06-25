import { z } from "zod";

/**
 * 求职神器(Resume Tailor)的结构化输出定义。
 * - zod schema 用于运行时校验 / 规整(normalize)
 * - JSON Schema 用于 OpenAI Structured Outputs(strict 模式)
 * 数量 / 取值范围等约束统一在 normalize 里用代码强制,不依赖 strict 模式对
 * minItems/maximum 的支持。
 *
 * 简历结构对齐用户偏好的 HTML 模板:headline 标语 + 联系方式 + Summary 要点 +
 * Experience(每条含 项目描述 / 职责要点 / 技术栈) + 其它通用区块(Education/Skills 等)。
 */

// 各字段上限:对真实简历极宽松,但给两条链路(模型输出 / 导出端客户端入参)兜底,
// 避免畸形 / 恶意超大负载被同步渲染拖垮进程。
const MAX = {
  shortStr: 600,
  headline: 300,
  para: 4000,
  bullet: 2000,
  coverLetter: 20_000,
  keyword: 300,
  contacts: 10,
  summary: 30,
  experience: 30,
  responsibilities: 60,
  sections: 30,
  items: 50,
  bullets: 50,
  keywords: 150,
  changeSummary: 100,
} as const;

/** 一段工作经历(对齐模板的 Experience 卡片) */
export const ExperienceSchema = z.object({
  company: z.string().max(MAX.shortStr), // 公司 + 地点,如 "NetSuite, San Lorenzo, CA"
  dates: z.string().max(MAX.shortStr), // 时间段(可空)
  role: z.string().max(MAX.shortStr), // 职位(可空)
  projectDescription: z.string().max(MAX.para), // 项目/背景描述段落(可空)
  responsibilities: z.array(z.string().max(MAX.bullet)).max(MAX.responsibilities), // 职责要点
  environment: z.string().max(MAX.para), // 技术栈一行(可空)
});

/** 通用区块的一条目(Education / Projects 等) */
export const ResumeItemSchema = z.object({
  title: z.string().max(MAX.shortStr), // 学位 / 项目名 / 条目标题(可空)
  subtitle: z.string().max(MAX.shortStr), // 学校 / 机构(可空)
  dateRange: z.string().max(MAX.shortStr), // 时间段(可空)
  bullets: z.array(z.string().max(MAX.bullet)).max(MAX.bullets), // 要点(技能区可作技能条目)
});

/** 通用区块,如 Education / Skills / Certifications */
export const ResumeSectionSchema = z.object({
  heading: z.string().max(MAX.headline),
  items: z.array(ResumeItemSchema).max(MAX.items),
});

/** 改写后的简历主体 */
export const TailoredResumeSchema = z.object({
  name: z.string().max(MAX.shortStr),
  headline: z.string().max(MAX.headline), // 职位标语,按 JD 定制,如 "Java Developer / AI Engineer"
  contacts: z.array(z.string().max(MAX.shortStr)).max(MAX.contacts), // 联系方式行,沿用原简历
  summary: z.array(z.string().max(MAX.bullet)).max(MAX.summary), // 专业摘要要点
  experience: z.array(ExperienceSchema).max(MAX.experience),
  sections: z.array(ResumeSectionSchema).max(MAX.sections), // 其它区块
});

/** 匹配分析(给运营者看,中文) */
export const AnalysisSchema = z.object({
  matchScore: z.number(),
  addedKeywords: z.array(z.string().max(MAX.keyword)).max(MAX.keywords),
  missingKeywords: z.array(z.string().max(MAX.keyword)).max(MAX.keywords),
  changeSummary: z.array(z.string().max(MAX.bullet)).max(MAX.changeSummary),
});

/** 模型返回的完整结构 */
export const JobHunterSchema = z.object({
  language: z.string().max(MAX.headline),
  resume: TailoredResumeSchema,
  coverLetter: z.string().max(MAX.coverLetter),
  analysis: AnalysisSchema,
});

export type Experience = z.infer<typeof ExperienceSchema>;
export type ResumeItem = z.infer<typeof ResumeItemSchema>;
export type ResumeSection = z.infer<typeof ResumeSectionSchema>;
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type JobHunterResult = z.infer<typeof JobHunterSchema>;

/** 模型返回不符合要求时抛出,触发一次自动重试 */
export class SchemaValidationError extends Error {}

/** 发送给 OpenAI 的严格 JSON Schema(Structured Outputs) */
export const JOB_HUNTER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: {
      type: "string",
      description: "简历与求职信实际使用的语言,例如 English 或 中文。须与 JD 语言一致。",
    },
    resume: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "候选人姓名(保持原简历不变)" },
        headline: {
          type: "string",
          description:
            "职位标语 / headline,按目标 JD 定制,如 'Java Developer / AI Engineer / E-Commerce'。",
        },
        contacts: {
          type: "array",
          description:
            "联系方式行,沿用原简历(如 'Phone: ...'、'Email: ...'、'Location: ... | Work Auth: ...')。不要编造。",
          items: { type: "string" },
        },
        summary: {
          type: "array",
          description: "专业摘要要点(Professional Summary),针对该 JD 重排与强化,每条一句。",
          items: { type: "string" },
        },
        experience: {
          type: "array",
          description: "工作经历,按对该岗位的相关性排序。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              company: {
                type: "string",
                description: "公司 + 地点,如 'NetSuite, San Lorenzo, CA'",
              },
              dates: { type: "string", description: "时间段,无则留空" },
              role: { type: "string", description: "职位,无则留空" },
              projectDescription: {
                type: "string",
                description: "项目 / 背景描述段落,无则留空",
              },
              responsibilities: {
                type: "array",
                description: "职责 / 成就要点,以行动动词开头并尽量量化",
                items: { type: "string" },
              },
              environment: {
                type: "string",
                description: "技术栈一行(Environment),无则留空",
              },
            },
            required: [
              "company",
              "dates",
              "role",
              "projectDescription",
              "responsibilities",
              "environment",
            ],
          },
        },
        sections: {
          type: "array",
          description: "其它区块,如 Education / Skills / Certifications / Projects。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              heading: { type: "string", description: "区块标题" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string", description: "条目标题,无则留空" },
                    subtitle: { type: "string", description: "学校 / 机构,无则留空" },
                    dateRange: { type: "string", description: "时间段,无则留空" },
                    bullets: {
                      type: "array",
                      description: "要点;技能区块可用作技能条目",
                      items: { type: "string" },
                    },
                  },
                  required: ["title", "subtitle", "dateRange", "bullets"],
                },
              },
            },
            required: ["heading", "items"],
          },
        },
      },
      required: ["name", "headline", "contacts", "summary", "experience", "sections"],
    },
    coverLetter: {
      type: "string",
      description: "针对该 JD 的求职信,段落之间用空行分隔,语言与简历一致。",
    },
    analysis: {
      type: "object",
      additionalProperties: false,
      properties: {
        matchScore: {
          type: "integer",
          description: "改写后简历与 JD 的匹配度,0~100 的整数。",
        },
        addedKeywords: {
          type: "array",
          description: "已在简历中强化 / 体现的 JD 关键词。",
          items: { type: "string" },
        },
        missingKeywords: {
          type: "array",
          description: "JD 要求、但候选人简历仍缺失或可能不具备的关键词。",
          items: { type: "string" },
        },
        changeSummary: {
          type: "array",
          description: "本次针对 JD 所做改动的要点,必须用简体中文。",
          items: { type: "string" },
        },
      },
      required: ["matchScore", "addedKeywords", "missingKeywords", "changeSummary"],
    },
  },
  required: ["language", "resume", "coverLetter", "analysis"],
} as const;

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const s = raw.trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function cleanList(arr: string[]): string[] {
  return arr.map((s) => s.trim()).filter(Boolean);
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 校验并规整模型输出:去空白 / 空条目;关键词去重;matchScore 夹到 0~100;
 * 简历必须至少有 summary、experience 或一个区块,否则抛错触发重试。
 */
export function normalizeResult(input: unknown): JobHunterResult {
  const parsed = JobHunterSchema.parse(input);
  const r = parsed.resume;

  const summary = cleanList(r.summary);

  const experience = r.experience
    .map((e) => ({
      company: e.company.trim(),
      dates: e.dates.trim(),
      role: e.role.trim(),
      projectDescription: e.projectDescription.trim(),
      responsibilities: cleanList(e.responsibilities),
      environment: e.environment.trim(),
    }))
    .filter(
      (e) =>
        e.company ||
        e.role ||
        e.projectDescription ||
        e.responsibilities.length ||
        e.environment,
    );

  const sections = r.sections
    .map((sec) => ({
      heading: sec.heading.trim(),
      items: sec.items
        .map((it) => ({
          title: it.title.trim(),
          subtitle: it.subtitle.trim(),
          dateRange: it.dateRange.trim(),
          bullets: cleanList(it.bullets),
        }))
        .filter((it) => it.title || it.subtitle || it.dateRange || it.bullets.length),
    }))
    .filter((sec) => sec.heading && sec.items.length);

  if (!summary.length && !experience.length && !sections.length) {
    throw new SchemaValidationError("简历内容为空");
  }

  const coverLetter = parsed.coverLetter.trim();
  if (!coverLetter) {
    throw new SchemaValidationError("求职信为空");
  }

  return {
    language: parsed.language.trim() || "English",
    resume: {
      name: r.name.trim(),
      headline: r.headline.trim(),
      contacts: cleanList(r.contacts),
      summary,
      experience,
      sections,
    },
    coverLetter,
    analysis: {
      matchScore: clampScore(parsed.analysis.matchScore),
      addedKeywords: dedupe(parsed.analysis.addedKeywords),
      missingKeywords: dedupe(parsed.analysis.missingKeywords),
      changeSummary: cleanList(parsed.analysis.changeSummary),
    },
  };
}
