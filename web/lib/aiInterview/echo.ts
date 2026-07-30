import type { Turn } from "./schema";

/**
 * 外放(不戴耳机)时的回声抑制。
 *
 * 场景:面试官的声音从扬声器出来,又被你的麦克风录了一遍。于是同一句话会出现两次 ——
 * 一次在「面试官」通道(系统声音),一次在「我」通道(麦克风)。后果比重复更严重:
 * 字幕最后一句变成了「我」,提问判定会以为「你已经在答了」,于是**不再自动生成答案**。
 *
 * 怎么判:我们两条通道都有,而且系统声音那一路就是「扬声器到底放了什么」的参考信号。
 * 所以不用做声学回声消除,只看两件事就够:
 *   ① 时间上重不重叠(同一时刻面试官在说话)
 *   ② 文字像不像(同一句话被听了两遍)
 * 两条都命中 → 判为回声,丢掉。纯函数,可单测(见 echo.test.ts)。
 */

/** 说这段话大概占多久(和 question.ts 口径一致:中文 200ms/字,英文 55ms/字符) */
export function estimateSpokenMs(text: string): number {
  const cn = (text.match(/[一-鿿]/g) || []).length;
  return Math.max(300, cn * 200 + (text.length - cn) * 55);
}

export type Span = { from: number; to: number };

export function spanOf(turn: Turn): Span {
  return { from: turn.at, to: turn.at + estimateSpokenMs(turn.text) };
}

/** a 有多大比例落在 b 里(0~1) */
export function overlapRatio(a: Span, b: Span): number {
  const lo = Math.max(a.from, b.from);
  const hi = Math.min(a.to, b.to);
  const len = a.to - a.from;
  if (len <= 0) return 0;
  return Math.max(0, hi - lo) / len;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "so", "to", "of", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "do", "does", "did", "you", "your", "i", "me", "my",
  "we", "it", "that", "this", "about", "how", "what", "why", "when",
]);

function tokens(text: string): string[] {
  const cn = text.match(/[一-鿿]/g) || [];
  const en = (text.toLowerCase().match(/[a-z0-9']{2,}/g) || []).filter((w) => !STOP.has(w));
  return [...en, ...cn];
}

/**
 * 「短的那句有多少词出现在长的那句里」(包含度,不是 Jaccard)。
 * 回声常常只录到半句,用 Jaccard 会因为长度差异被拉低,漏判。
 */
export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bag = new Set(long);
  const hit = short.filter((t) => bag.has(t)).length;
  return hit / short.length;
}

export type EchoOptions = {
  /** 时间重叠阈值 */
  minOverlap: number;
  /** 文字相似度阈值(重叠很高时用更松的那个) */
  minSimilarity: number;
  minSimilarityStrongOverlap: number;
  /** 只和最近这么久内的面试官发言比 */
  lookbackMs: number;
};

export const DEFAULT_ECHO: EchoOptions = {
  minOverlap: 0.45,
  minSimilarity: 0.5,
  minSimilarityStrongOverlap: 0.3,
  lookbackMs: 30_000,
};

/**
 * 这句「我」的转写是不是扬声器回声?
 * 只有「同时在说」且「说的是同一句」才判是 —— 你真的在这时候插话(内容不同)不会被误杀。
 */
export function looksLikeEcho(
  mic: Turn,
  turns: Turn[],
  opts: EchoOptions = DEFAULT_ECHO,
): boolean {
  if (mic.role !== "me" || !mic.text.trim()) return false;
  const micSpan = spanOf(mic);
  for (const t of turns) {
    if (t.role !== "interviewer") continue;
    if (mic.at - t.at > opts.lookbackMs) continue;
    const overlap = overlapRatio(micSpan, spanOf(t));
    if (overlap < opts.minOverlap) continue;
    const sim = textSimilarity(mic.text, t.text);
    const need = overlap >= 0.8 ? opts.minSimilarityStrongOverlap : opts.minSimilarity;
    if (sim >= need) return true;
  }
  return false;
}
