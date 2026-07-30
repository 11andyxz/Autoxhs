import { LIMITS, type Role, type Turn } from "./schema";

/**
 * 实时字幕的纯函数层:插句、合并、取滚动窗口、拼进提示词、导出 Markdown。
 *
 * 转写是「一段音频一次请求」并发发出去的,回来的顺序不保证,所以插入要按时间排;
 * 同一个人连着说的几段(VAD 在停顿处切开的)要合成一句,不然字幕会碎成一行行短句,
 * 模型也会以为面试官说了很多轮。
 */

/** 同一角色相邻两段间隔小于这个值就当一句话被切开了(毫秒) */
const MERGE_GAP_MS = 2_000;

/** 合并两段文本:前一段没有终止标点时补空格/直接接上(中文不加空格)。 */
function joinText(prev: string, next: string): string {
  const a = prev.trimEnd();
  const b = next.trimStart();
  if (!a) return b;
  if (!b) return a;
  const needSpace = /[A-Za-z0-9,;:'")\]]$/.test(a) && /^[A-Za-z0-9("'\[]/.test(b);
  return needSpace ? `${a} ${b}` : a + b;
}

/**
 * 把一句新转写插进字幕数组,返回新数组(不改原数组)。
 * - 和最后一句同角色、时间够近 → 合并进去(段被 VAD 切开的情况)
 * - 否则按 at 升序插到正确位置(乱序返回时不会把字幕顺序搞乱)
 */
export function insertTurn(turns: Turn[], turn: Turn): Turn[] {
  const text = turn.text.trim();
  if (!text) return turns;
  const next = { ...turn, text };

  const last = turns[turns.length - 1];
  if (
    last &&
    last.role === next.role &&
    // 只合并「接在最后一句之后」的段:乱序回来的旧片段要插回原位,不能并进末尾。
    next.at >= last.at &&
    next.at - last.at < MERGE_GAP_MS + last.text.length * 30
  ) {
    // 用「上一句的时间 + 文本长度」放宽窗口:长句本身占时间,不能只看开始时间差。
    const merged = [...turns];
    merged[merged.length - 1] = { ...last, text: joinText(last.text, next.text) };
    return merged;
  }

  if (!last || next.at >= last.at) return [...turns, next];

  const out = [...turns];
  let i = out.length - 1;
  while (i >= 0 && out[i].at > next.at) i -= 1;
  out.splice(i + 1, 0, next);
  return out;
}

/** 最近 seconds 秒 / 最多 maxTurns 句的滚动窗口(送模型用)。now 传当前会话内偏移。 */
export function windowFor(
  turns: Turn[],
  now: number,
  seconds = 300,
  maxTurns: number = LIMITS.windowTurns,
): Turn[] {
  const from = now - seconds * 1000;
  const recent = turns.filter((t) => t.at >= from);
  const picked = recent.length ? recent : turns;
  return picked.slice(-maxTurns);
}

const ROLE_TAG: Record<Role, string> = {
  interviewer: "interviewer",
  me: "me",
  assistant: "suggested-answer",
};

/**
 * 把窗口拼成提示词里的文本。从后往前累加,保证「最近的对话一定在」,
 * 超过字数上限就丢最早的(实时场景里旧内容价值低)。
 */
export function formatWindow(turns: Turn[], maxChars: number = LIMITS.windowChars): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    const line = `[${ROLE_TAG[t.role]}] ${t.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}

/**
 * Whisper 在「几乎没人说话」的片段上会凭空吐字幕垃圾:网址、"Thanks for watching"、
 * 「字幕由…提供」之类(实测麦克风通道在安静时反复吐 https://www.linkedin.com.au)。
 * 整条文本命中这些形状就当没听到 —— 否则它们会进字幕、还会被当成提问去生成答案。
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^(?:https?:\/\/|www\.)\S+$/i,
  /^(?:thanks?|thank you)(?: (?:you|so much))? for watching[.!]?$/i,
  /^(?:please )?(?:subscribe|like and subscribe)(?: to my channel)?[.!]?$/i,
  /^see you (?:next time|in the next video)[.!]?$/i,
  /^subtitles? (?:by|provided by)\b.*$/i,
  /^(?:amara\.org|www\.amara\.org)\b.*$/i,
  /^字幕(?:由|组).*$/,
  /^(?:请不吝点赞|感谢观看|谢谢观看|请订阅|订阅我的频道|明镜与点点栏目).*$/,
];

/** 只有标点/空白/点点点(听到的其实是静音或环境噪声) */
const PUNCT_ONLY = /^[\s.,、。·…!?!?~\-—_"'“”()()\[\]:;:;]+$/;

/**
 * 同一小段重复刷屏:whisper 在噪声上最典型的幻觉形态,
 * 实测出现过「無垢無缺無缺無缺…」这种整屏重复(2026-07-29 真实面试录到)。
 */
function isRepeatedJunk(t: string): boolean {
  const compact = t.replace(/\s+/g, "");
  if (compact.length < 12) return false;
  // ① 整条就是某个小片段的重复(从头对齐)
  for (let unit = 1; unit <= 6; unit += 1) {
    const times = Math.floor(compact.length / unit);
    if (times < 5) continue;
    if (compact.slice(0, unit).repeat(times) === compact.slice(0, unit * times)) return true;
  }
  // ② 用字太少:重复片段不一定从第一个字开始(实测那条是「無垢」+「無缺」×N),
  //    但这种刷屏的共同点是「很长、却只用了几个字」。正常句子的用字比例远高于此。
  const distinct = new Set(compact).size;
  if (distinct / compact.length < 0.25) return true;
  return false;
}

/** 中日韩字符占比 */
function cjkRatio(t: string): number {
  const letters = t.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters.length) return 0;
  const cjk = (letters.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk / letters.length;
}

/**
 * 判断一条转写是不是幻觉/垃圾。language 传本场设定的语言(如 "en"):
 * 明确设了英文却吐出成片中日韩字符,基本可以断定是噪声幻觉 —— 实测面试中出现过
 * 「Redeployment, Communications, Campaign…」这类词汇沙拉和整屏重复的日文汉字。
 */
export function looksLikeHallucination(text: string, language?: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (HALLUCINATION_PATTERNS.some((re) => re.test(t))) return true;
  if (PUNCT_ONLY.test(t)) return true;
  if (isRepeatedJunk(t)) return true;
  if (language === "en" && cjkRatio(t) > 0.3) return true;
  return false;
}

/**
 * 转写结果是不是「把我们给的 prompt 提示词原样吐回来了」。
 *
 * 实测:静音片段喂给 gpt-4o-mini-transcribe / gpt-4o-transcribe 时,它会把 prompt 里的
 * 术语列表当成识别结果返回(「Kafka, Kubernetes, Spring Boot, JVM…」)。这些词来自简历/JD,
 * 看起来非常像面试官真说了什么,会污染字幕并触发生成答案。和具体模型无关,统一挡在这里。
 */
export function echoesPrompt(text: string, hint?: string): boolean {
  const t = text.trim();
  if (!t || !hint?.trim()) return false;
  const norm = (v: string) =>
    v.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const words = norm(t);
  if (!words.length) return false;
  const bag = new Set(norm(hint));
  if (!bag.size) return false;
  const hit = words.filter((w) => bag.has(w)).length;
  // 整句几乎全是提示词里的词 → 是回声而不是人说的话(正常句子会有动词、冠词等提示词里没有的词)
  return hit / words.length >= 0.8;
}

/** 最后一句面试官说的话(找不到返回空串) */
export function lastInterviewerText(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "interviewer") return turns[i].text;
  }
  return "";
}

function stamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ROLE_CN: Record<Role, string> = {
  interviewer: "面试官",
  me: "我",
  assistant: "AI 建议",
};

/** 导出 Markdown:抬头 + 总结 + 全文逐句(带时间戳)。 */
export function toMarkdown(meta: {
  title: string;
  company: string;
  mode: string;
  startedAt: string;
  summary?: string;
  turns: Turn[];
}): string {
  const out: string[] = [`# ${meta.title || "AI 辅助面试记录"}`, ""];
  const head = [
    meta.company ? `- 公司:${meta.company}` : "",
    `- 模式:${meta.mode}`,
    `- 开始时间:${meta.startedAt}`,
    `- 对话条数:${meta.turns.length}`,
  ].filter(Boolean);
  out.push(...head, "");
  if (meta.summary?.trim()) {
    out.push("## 复盘总结", "", meta.summary.trim(), "");
  }
  out.push("## 全文记录", "");
  for (const t of meta.turns) {
    out.push(`**[${stamp(t.at)}] ${ROLE_CN[t.role]}:** ${t.text}`, "");
  }
  return out.join("\n");
}
