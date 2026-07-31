/**
 * 「结合我的项目」——给猛攻版的问答卡再加一份**简历版**回答(原答案一字不动,存在
 * ip_cram_card.project_answer 里,复习时显示在原答案下面)。
 *
 * 这里只放纯逻辑(挑输入 / 简历取文 / 清洗输出),好被单测覆盖;碰 DB 和 OpenAI 的部分在
 * app/api/job-hunter/interview/cram/project-answer/route.ts。
 */

/** 喂给模型的简历上限(约 3.5k tokens):够一份简历加一些追加材料,又不至于把请求撑肥。 */
export const MAX_RESUME_CHARS = 14_000;
/** 与 ip_cram_card.project_answer 的入库截断一致(和 content 同口径)。 */
export const MAX_PROJECT_ANSWER = 8_000;
/** 题面/原答案喂给模型时的上限(与 refine 路由同口径)。 */
export const MAX_QUESTION = 2_000;
export const MAX_BASE_ANSWER = 8_000;

/** 少于这么多字的「简历」基本是空壳(只有标题或几个词),硬编只会让模型编造项目。 */
const MIN_USEFUL_RESUME = 80;

/** 没有正面的知识块:用正文开头当「问题」,别把整段正文再当一次题面。 */
const QUESTION_FROM_CONTENT = 300;

/**
 * 卡片 → 模型输入。返回 null 表示这张卡没东西可结合(正反面都空)。
 * front 是题面(题库导入的问答卡都有);没有 front 的知识块退回用正文开头当题面。
 */
export function projectAnswerInputs(card: {
  front?: string | null;
  content?: string | null;
}): { question: string; baseAnswer: string } | null {
  const front = (card.front ?? "").trim();
  const content = (card.content ?? "").trim();
  if (!front && !content) return null;
  const question = (front || content.slice(0, QUESTION_FROM_CONTENT)).slice(0, MAX_QUESTION);
  return { question, baseAnswer: content.slice(0, MAX_BASE_ANSWER) };
}

/**
 * 这份简历(session 里存的 HTML)→ 给模型读的纯文本。保留分段和项目符号 —— 简历的
 * 「哪个项目下有哪几条」全靠这个结构,压成一行模型就分不清哪条属于哪个项目了。
 *
 * 故意不复用另外两份 htmlToText:
 * - cram/session/route.ts 那份压成单行、是 resume_hash 的输入,动它等于让所有 session 去重键漂移;
 * - lib/job-hunter/align.ts 那份会连带 import OpenAI 客户端,不适合放在纯逻辑模块里。
 */
export function resumeTextFromHtml(html: string): string {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<li\b[^>]*>/gi, "\n• ");
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol|table)\s*>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
  return t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n") // 开标签被换成空格后行首会留一个空格,去掉
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 截给模型的那一段。从**开头**截:简历先上传、追加的复习资料在后面,开头才是项目经历。 */
export function clipResumeForPrompt(text: string): string {
  return text.slice(0, MAX_RESUME_CHARS);
}

export function hasUsableResume(text: string): boolean {
  return text.trim().length >= MIN_USEFUL_RESUME;
}

/** 模型偶尔把整段答案用 ``` 围栏包起来 / 加空行,去掉再落库。 */
export function cleanProjectAnswer(raw: string): string {
  let t = raw.trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  return t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, MAX_PROJECT_ANSWER).trim();
}
