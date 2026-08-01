/**
 * 代码佐证的**排序/截取**逻辑(纯函数,不碰 fs,好单测)。
 * 目标只有一个:给定「这道面试题 + 卡上的原答案」,从一个仓库里挑出**真的相关**的几段代码。
 * 用词面打分而不是向量检索 —— 面试题里的关键词(detokenization / idempotent / GC / cache)
 * 基本就是代码里的标识符,词面命中已经够准,而且零成本、可解释、结果稳定。
 */

/** 英文停用词 + 面试题里到处都是的高频词(留着只会让所有文件都得分)。 */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "how", "what", "why", "when", "which",
  "are", "was", "were", "can", "could", "would", "should", "will", "into", "from", "about", "does",
  "did", "have", "has", "had", "not", "but", "its", "it's", "use", "used", "using", "there", "their",
  "them", "then", "than", "also", "each", "any", "all", "some", "such", "very", "more", "most", "one",
  "two", "example", "examples", "project", "projects", "question", "answer", "interview", "explain",
  "difference", "differences", "between", "types", "type", "deal", "work", "works", "like",
]);

/** 驼峰/下划线/点都切开,`ControllerAdvice` → controller advice;同时保留原词。 */
function splitIdentifier(word: string): string[] {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  return parts.length > 1 ? [word, ...parts] : [word];
}

/** 提问 + 原答案 → 检索词(去停用词、去重、按长度优先,最多 40 个)。 */
export function queryTerms(text: string): string[] {
  const raw = text.match(/[A-Za-z][A-Za-z0-9_.$-]{2,}/g) || [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of raw) {
    for (const piece of splitIdentifier(w)) {
      const t = piece.toLowerCase();
      if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
      seen.add(t);
      terms.push(t);
    }
  }
  // 长词更有辨识度(detokenization > api),优先保留。
  return terms.sort((a, b) => b.length - a.length).slice(0, 40);
}

const PATH_W = 3; // 词出现在路径/文件名里 —— 最强信号(DetokenizationService.java 就是在讲这件事)
const MAIN_BONUS = 1.15; // 主代码略优于测试;测试仍可入选(它常常就是最好的佐证)

/**
 * 一个文件对这批检索词的相关度。0 = 完全不相关(调用方据此丢弃)。
 *
 * 两条设计取舍(都有单测钉着):
 * 1. **命中的不同词多 > 同一个词命中次数多**。词频只给最多 +50% 的加成(log 饱和),
 *    所以「cache 出现 30 次」的配置类压不过「cache + detokenization 各出现一次」的那个类 ——
 *    后者才是同时讲这两件事的地方。
 * 2. **长词更值钱**。detokenization / idempotency 这种词几乎只出现在真正相关的文件里,
 *    api / service 到处都是;按词长做一个 1.19x–2x 的粗糙 IDF,比统计真 IDF 便宜且够用。
 */
export function scoreText(terms: string[], relPath: string, content: string): number {
  const lowerPath = relPath.toLowerCase();
  const lowerBody = content.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const inPath = lowerPath.includes(t);
    const n = countOccurrences(lowerBody, t);
    if (!inPath && !n) continue;
    const rarity = 1 + Math.min(t.length, 16) / 16; // 1.19x(3 字母)~ 2x(≥16 字母)
    const freq = n ? 1 + Math.min(Math.log2(n), 3) / 6 : 0; // 1 次=1.0,8 次以上封顶 1.5
    score += rarity * ((inPath ? PATH_W : 0) + freq);
  }
  if (!score) return 0;
  const isTest = /(^|\/)(test|tests|it)\//.test(lowerPath) || /test\.[a-z]+$/.test(lowerPath);
  return score * (isTest ? 1 : MAIN_BONUS);
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < 50) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 从文件里截一段最相关的:以「命中词最密集的那一行」为中心按行展开到 maxChars。
 * 小文件直接整篇给(上下文完整,模型更容易挑对片段);行号从 1 开始,便于回溯。
 */
export function pickExcerpt(
  content: string,
  terms: string[],
  maxChars: number,
): { text: string; startLine: number; endLine: number } {
  const lines = content.split("\n");
  if (content.length <= maxChars) {
    return { text: content, startLine: 1, endLine: lines.length };
  }
  const lower = lines.map((l) => l.toLowerCase());
  // 每行的命中数 → 滑动窗口(前后各 3 行)找密度最高的中心行。
  const hits = lower.map((l) => terms.reduce((n, t) => (l.includes(t) ? n + 1 : n), 0));
  let best = 0;
  let bestAt = 0;
  for (let i = 0; i < hits.length; i++) {
    let w = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(hits.length - 1, i + 3); j++) w += hits[j];
    if (w > best) {
      best = w;
      bestAt = i;
    }
  }
  // 以 bestAt 为中心向两边扩,直到吃满预算。
  let start = bestAt;
  let end = bestAt;
  let size = lines[bestAt].length + 1;
  while (size < maxChars && (start > 0 || end < lines.length - 1)) {
    if (start > 0) {
      const next = lines[start - 1].length + 1;
      if (size + next > maxChars) break;
      start -= 1;
      size += next;
    }
    if (end < lines.length - 1) {
      const next = lines[end + 1].length + 1;
      if (size + next > maxChars) break;
      end += 1;
      size += next;
    }
    if (start === 0 && end === lines.length - 1) break;
  }
  return { text: lines.slice(start, end + 1).join("\n"), startLine: start + 1, endLine: end + 1 };
}
