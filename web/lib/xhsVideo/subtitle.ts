/**
 * 逐句同步字幕的两件事:
 *  1. 把一段口播拆成一行行短字幕(按中文标点断句,过长再切)。
 *  2. 在该段配音总时长内,按每行字数比例分配每行的显示时长 —— 每段各自归一,
 *     每段内各行时长之和 == 该段音频时长,所以段与段之间不会累积漂移(段边界处会重新对齐)。
 *
 * 用「按字数比例」估算而非逐词强制对齐:TTS 语速较均匀,估算已足够贴合,且显示文本用的是
 * 我们自己的原始口播(逐词识别可能带来转写错字),显示更干净。
 */

const MERGE_ORPHAN_UNDER = 5; // 过短的碎行(如「学姐」)并回相邻行,避免闪现孤字
const MERGE_MAX_CHARS = 18; // 合并/断句时的字数上限参考(可再靠 CSS 换成 1~2 视觉行)
const HARD_MAX_CHARS = 24; // 只有超过这个长度的「无标点长句」才硬切,避免把词拆断

/** 去掉行尾的中文/英文标点,让字幕更干净(保留行中标点)。 */
function trimTrailingPunct(s: string): string {
  return s.replace(/[。，、；;,\s]+$/u, "").trim();
}

/** 计入时长权重的有效字数(不含空白)。 */
function weight(line: string): number {
  return Math.max(1, line.replace(/\s/g, "").length);
}

/**
 * 断句:直接按自然标点(句末 + 逗号/顿号)切成小句,不做定长硬切 —— 这样不会把词/英文单词拆断,
 * 每小句交给 CSS 自动换成 1~2 视觉行即可。只有极少数「超长且无内部标点」的小句才在空格或中点硬切一次。
 */
export function splitNarrationIntoLines(narration: string): string[] {
  const text = narration.trim();
  if (!text) return [];

  const clauses = text
    .split(/(?<=[。！？；!?;，、,])/u)
    .map((c) => trimTrailingPunct(c))
    .filter(Boolean);

  const lines: string[] = [];
  for (const clause of clauses) {
    if (clause.length <= HARD_MAX_CHARS) {
      lines.push(clause);
      continue;
    }
    // 超长且无内部标点:优先在空格处断(保住英文词),否则在中点附近硬切成两段
    const mid = Math.ceil(clause.length / 2);
    const spaceIdx = clause.lastIndexOf(" ", mid);
    const cut = spaceIdx > 3 ? spaceIdx : mid;
    lines.push(clause.slice(0, cut).trim(), clause.slice(cut).trim());
  }

  return mergeOrphans(lines.filter(Boolean));
}

/**
 * 把过短的碎行并入相邻行:优先并回前一行(合并后不超过 MAX+4 就并),否则并入后一行;
 * 都不行(前后都会太长)就保留。让字幕以较完整的短句出现,而不是闪现一两个字。
 */
function mergeOrphans(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      line.replace(/\s/g, "").length < MERGE_ORPHAN_UNDER &&
      (prev + line).length <= MERGE_MAX_CHARS + 4
    ) {
      out[out.length - 1] = prev + line;
    } else if (
      prev !== undefined &&
      prev.replace(/\s/g, "").length < MERGE_ORPHAN_UNDER &&
      (prev + line).length <= MERGE_MAX_CHARS + 4
    ) {
      out[out.length - 1] = prev + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * 在 totalSec 内按字数比例分配每行时长;各项之和精确等于 totalSec(末行吸收舍入误差)。
 */
export function distributeDurations(lines: string[], totalSec: number): number[] {
  const n = lines.length;
  if (n === 0) return [];
  if (n === 1) return [totalSec];

  const weights = lines.map(weight);
  const sum = weights.reduce((a, b) => a + b, 0);
  const durations: number[] = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const d = Math.round(((totalSec * weights[i]) / sum) * 1000) / 1000;
    durations.push(d);
    acc += d;
  }
  durations.push(Math.max(0.1, Math.round((totalSec - acc) * 1000) / 1000));
  return durations;
}
