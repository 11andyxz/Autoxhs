import {
  LIMITS,
  asLang,
  asMode,
  clip,
  parseTurns,
  type Lang,
  type Mode,
  type Turn,
} from "./schema";
import { sanitizeUntrusted } from "./prompt";

/**
 * 桌面端(natively-cluely-ai-assistant + Autoxhs 集成层)回传给网页的数据形状。
 *
 * 为什么要单独一层:桌面端跑在 Electron 主进程里,它拿到的是「一场会已经结束」的完整快照
 * (整份字幕 + 想入库的知识块),不像浏览器版那样一边听一边 PATCH。所以它走自己的两个接口
 * (/api/ai-interview/desktop/*),校验放这里,和浏览器版的 schema.ts 共用限额与枚举。
 *
 * 实时那一路不在这里:桌面端直接复用已有的 /api/ai-interview/live/publish + liveHub,
 * 手机副屏(/ai-interview/view)不需要任何改动就能看桌面端的这场面试。
 */

/** 一次入库最多带多少个知识块(面试里真正值得复习的问题不会有几十个) */
export const MAX_KNOWLEDGE_ITEMS = 40;

export type DesktopKnowledgeItem = {
  /** 正面:面试官的问题 */
  front: string;
  /** 背面:当时给出的答案 / 复盘要点 */
  content: string;
};

export type DesktopSessionPayload = {
  title: string;
  company: string;
  mode: Mode;
  lang: Lang;
  jd: string;
  notes: string;
  summary: string;
  turns: Turn[];
  /** 顺带加入「知识块」按遗忘曲线复习的问答(空数组=不加) */
  knowledge: DesktopKnowledgeItem[];
};

/** 桌面端一场面试的整份字幕:比浏览器版单次 PATCH 的上限宽一些,一场两小时的会也装得下 */
const DESKTOP_MAX_TURNS = 2_000;

export function parseKnowledgeItems(v: unknown): DesktopKnowledgeItem[] {
  if (!Array.isArray(v)) return [];
  const out: DesktopKnowledgeItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { front?: unknown; content?: unknown };
    // 中和之后再存。这两个字段来自面试官的转写和模型的输出,而它们会作为
    // ip_knowledge 的行长期留着,之后又被喂回复习/回答的提示词里 —— 也就是说
    // 这里是一条「现在写入、以后当指令读」的路径。实时回答那条路已经用
    // sanitizeUntrusted 中和过了(见 prompt.ts),入库这条以前没有。
    const front = sanitizeUntrusted(clip(r.front, LIMITS.question));
    const content = sanitizeUntrusted(clip(r.content, LIMITS.prevAnswer));
    // 只有正反都在才值得复习:没有问题的答案在复习界面上是无头的,没有答案的问题等于没记住。
    if (!front || !content) continue;
    out.push({ front, content });
    if (out.length >= MAX_KNOWLEDGE_ITEMS) break;
  }
  return out;
}

export function parseDesktopSessionPayload(body: unknown): DesktopSessionPayload {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const company = clip(b.company, LIMITS.company);
  return {
    title: clip(b.title, LIMITS.title) || (company ? `${company} 面试(桌面端)` : "面试(桌面端)"),
    company,
    mode: asMode(b.mode),
    lang: asLang(b.lang),
    jd: clip(b.jd, LIMITS.jd),
    notes: clip(b.notes, LIMITS.notes),
    summary: clip(b.summary, LIMITS.summaryTokens * 4),
    turns: parseTurns(b.turns, DESKTOP_MAX_TURNS),
    knowledge: parseKnowledgeItems(b.knowledge),
  };
}

/**
 * 桌面端开一场面试前拉的上下文。
 * 简历走仓库里的默认简历(和浏览器版同一份);JD / 备忘 / 公司沿用上一场,
 * 桌面端面板上可以改 —— 换一家公司面试时不必再去翻网页。
 */
export type DesktopContext = {
  resume: string;
  resumeName: string;
  company: string;
  jd: string;
  notes: string;
  mode: Mode;
  lang: Lang;
  /** 上一场面试的 id(只用于说明「这些默认值是从哪来的」) */
  fromSessionId: number | null;
};
