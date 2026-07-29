/**
 * 「跟打代码」练习的纯逻辑:目标代码归一化 + 逐字跟打的判定与指标。
 * 不碰 DOM / 数据库,方便单测(typing.test.ts);页面只负责渲染和收集按键。
 *
 * 关键约定(严格模式):敲错的字符不落到输入里,只记一次错。
 * 这样「已敲内容」永远是目标代码的前缀 —— 渲染时前缀=已敲(深色)、其余=灰色答案,
 * 不需要做任何 diff 对齐,光标位置也永远等于已敲长度。
 */

export const TAB_WIDTH = 4;
/** 单题目标代码上限(太长的题不适合逐字跟打) */
export const MAX_CODE_CHARS = 4000;

/** 去掉模型偶尔带上的 ```lang 代码围栏 */
function stripFence(s: string): string {
  // 只在确实是围栏时才取内层;否则原样返回(不能整体 trim,那会吃掉第一行的缩进)。
  const m = s.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : s;
}

/**
 * 归一化目标代码:统一换行、Tab 展开成空格、去行尾空白与首尾空行、
 * 把中文引号/破折号等「敲不出来」的字符换回 ASCII。
 */
export function normalizeCode(src: string): string {
  return stripFence(src)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ".repeat(TAB_WIDTH))
    .replace(/[\u00a0\u2007\u202f\u3000]/g, " ") // 不间断空格/全角空格 → 普通空格
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .slice(0, MAX_CODE_CHARS);
}

/** 目标代码的行数(展示用) */
export function lineCount(code: string): number {
  return code ? code.split("\n").length : 0;
}

/**
 * 敲下换行后自动补齐的缩进长度:newlineIndex 是换行符自身的下标,
 * 返回下一行开头连续空格的个数(跟打时这段缩进由程序补,不用手敲)。
 */
export function indentSkip(target: string, newlineIndex: number): number {
  let i = newlineIndex + 1;
  let n = 0;
  while (i < target.length && target[i] === " ") {
    i += 1;
    n += 1;
  }
  return n;
}

/** 当前位置是否还在「行首缩进」里(前面到行头只有空格)——自动补缩进的地盘。 */
export function atLineIndent(target: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && target[i] === " ") i -= 1;
  return i < 0 || target[i] === "\n";
}

export type KeyOutcome = {
  /** 要追加到「已敲内容」的字符串(空串=这次按键不落字) */
  accept: string;
  /** 是否记一次错(敲错了) */
  error: boolean;
};

const IGNORED: KeyOutcome = { accept: "", error: false };

/**
 * 严格模式下处理一次按键:
 *  - 敲对了 → 落字;敲的是换行,顺带把下一行的缩进一起补上。
 *  - 还在行首缩进里却多敲了空格 → 直接忽略,不算错(缩进本来就是程序自动补的,
 *    习惯性再敲两下空格不该判错;行中间敲错空格仍然算错)。
 *  - 其余敲错 → 不落字,记一次错。
 */
export function applyKey(target: string, index: number, ch: string): KeyOutcome {
  if (index < 0 || index >= target.length || !ch) return IGNORED;
  const expected = target[index];
  if (ch === expected) {
    if (ch === "\n") return { accept: "\n" + " ".repeat(indentSkip(target, index)), error: false };
    return { accept: ch, error: false };
  }
  if (ch === " " && atLineIndent(target, index)) return IGNORED;
  return { accept: "", error: true };
}

export type InputOutcome = KeyOutcome & {
  /** 这次输入里被「吃掉」的源字符数(= 有效按键数;自动补的缩进不算) */
  consumed: number;
};

/**
 * 一次 input 事件可能带来多个字符(粘贴已禁,但 IME / 听写 / 自动补全仍可能一次给几个字)。
 * 逐字符走 applyKey,遇到第一个错就停(保持「已敲=前缀」的不变量)。
 */
export function applyInput(target: string, index: number, chunk: string): InputOutcome {
  let accept = "";
  let consumed = 0;
  let error = false;
  for (const ch of chunk) {
    const out = applyKey(target, index + accept.length, ch);
    if (out.error) {
      error = true;
      break;
    }
    // accept 为空 = 缩进位置多敲的空格,忽略掉但仍算一次按键。
    accept += out.accept;
    consumed += 1;
  }
  return { accept, consumed, error };
}

/* ---------------- IDE 模式:括号 / 引号自动补全 ---------------- */

/**
 * IDE 里没人从左到右一路敲到底 —— 敲 `Map<` 的瞬间 `>` 就自己出来了,你只往里填东西。
 * 这里照搬这个习惯:敲下开括号时,把它在参考代码里对应的那个闭括号标记成「已自动补」,
 * 光标走到那个位置就直接跳过去,不用你再敲。
 *
 * 仍然守住「已敲内容永远是目标代码的前缀」这个不变量 —— 自动补的字符也是照着参考代码填的,
 * 只是不算你的按键(不进手速统计)。
 */

const CLOSER_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'" };
const CLOSERS = new Set(Object.values(CLOSER_OF));

export function isCloser(ch: string): boolean {
  return CLOSERS.has(ch);
}

/** 这一行的结束位置(不含换行) */
function lineEnd(target: string, from: number): number {
  const nl = target.indexOf("\n", from);
  return nl < 0 ? target.length : nl;
}

/**
 * 参考代码里 i 位置这个开括号,配对的闭括号在哪。找不到返回 -1(那就不自动补,老老实实敲)。
 * - 引号:同一行里下一个未转义的同款引号。
 * - 尖括号:同一行内按深度配对(`a < b` 这种没有配对的 `>`,自然就返回 -1)。
 * - 圆/方/花括号:按深度配对,可以跨行(类体的 `}` 在很多行之后也算)。
 */
export function matchCloser(target: string, i: number): number {
  const open = target[i];
  const close = CLOSER_OF[open];
  if (!close) return -1;

  if (open === '"' || open === "'") {
    const end = lineEnd(target, i + 1);
    for (let j = i + 1; j < end; j++) {
      if (target[j] === "\\") {
        j += 1;
        continue;
      }
      if (target[j] === open) return j;
    }
    return -1;
  }

  const limit = open === "<" ? lineEnd(target, i + 1) : target.length;
  let depth = 0;
  for (let j = i; j < limit; j++) {
    if (target[j] === open) depth += 1;
    else if (target[j] === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export type IdeOutcome = InputOutcome & {
  /** 这次由程序自动补上的字符(不算按键;用来允许你出于习惯再敲一遍) */
  auto: string;
};

/**
 * IDE 模式下处理一次输入。`closed` 是「已经自动补过的位置」集合,会被就地更新(组件用 ref 持有)。
 * 习惯性又把闭括号敲了一遍 → 静默忽略,不算错(IDE 里这叫 overtype)。
 */
export function applyInputIde(
  target: string,
  index: number,
  chunk: string,
  closed: Set<number>,
): IdeOutcome {
  let pos = index;
  let accept = "";
  let consumed = 0;
  let error = false;
  let auto = "";
  // 光标停在「已自动补」的位置上就一路跳过去(连续的一串闭括号一次跳完)。
  const eat = () => {
    while (pos < target.length && closed.has(pos)) {
      accept += target[pos];
      auto += target[pos];
      pos += 1;
    }
  };
  // 紧挨光标前面那一串自动补出来的字符(可能是上一次输入时补的,所以从 closed 反推,不能只看这次)。
  const runBefore = () => {
    let r = "";
    for (let k = pos - 1; k >= 0 && closed.has(k); k--) r = target[k] + r;
    return r;
  };
  eat();
  let run = runBefore();

  for (const ch of chunk) {
    // 刚被自动补掉的闭括号,你又敲了一遍 → 吃掉这一下,不落字也不算错(IDE 里的 overtype)。
    const hit = isCloser(ch) ? run.indexOf(ch) : -1;
    if (hit >= 0) {
      run = run.slice(0, hit) + run.slice(hit + 1);
      consumed += 1;
      continue;
    }
    if (pos >= target.length) break;
    const out = applyKey(target, pos, ch);
    if (out.error) {
      error = true;
      break;
    }
    accept += out.accept;
    pos += out.accept.length;
    consumed += 1;
    // 敲下的是开括号 → 把配对的闭括号记成「已自动补」。
    if (out.accept === ch && CLOSER_OF[ch]) {
      const j = matchCloser(target, pos - 1);
      if (j >= pos) closed.add(j);
    }
    eat();
    run = runBefore();
  }
  return { accept, consumed, error, auto };
}

/** 退格到 len 之后,把 len 之后的自动补标记清掉(重新敲开括号会重新标记)。 */
export function dropClosedFrom(closed: Set<number>, len: number): void {
  for (const p of Array.from(closed)) if (p >= len) closed.delete(p);
}

/** 按 Tab 时:把当前位置的连续空格一次补完(补不了就当没按) */
export function tabSkip(target: string, index: number): string {
  let n = 0;
  while (index + n < target.length && target[index + n] === " ") n += 1;
  return " ".repeat(n);
}

/** WPM:按打字行业惯例 5 个字符算一个词,只统计真正敲下去的有效按键 */
export function calcWpm(keystrokes: number, elapsedMs: number): number {
  if (keystrokes <= 0 || elapsedMs <= 0) return 0;
  const minutes = elapsedMs / 60000;
  if (minutes <= 0) return 0;
  return Math.round(keystrokes / 5 / minutes);
}

/** 正确率 = 敲对的按键 / 总按键(含敲错的),0~100 */
export function calcAccuracy(keystrokes: number, errors: number): number {
  const total = keystrokes + errors;
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((keystrokes / total) * 100)));
}

/** 用时文案:1分23秒 */
export function durationLabel(elapsedMs: number): string {
  const sec = Math.max(0, Math.round(elapsedMs / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

/** 敲完这一遍后建议的自评档位(用户仍可自己改):看正确率和手速。 */
export type RecallGrade = "forgot" | "vague" | "clear";
export function suggestGrade(accuracy: number, wpm: number): RecallGrade {
  if (accuracy < 85) return "forgot";
  if (accuracy < 95 || wpm < 20) return "vague";
  return "clear";
}

/* ---------------- 「断点」面板:片段定位 + 代码分段渲染 ---------------- */

/**
 * 把代码切成若干段:已敲 / 未敲 × 是否在高亮区内 × 是否是「IDE 已经帮你补好、待会儿会跳过」的闭括号。
 * 边界点很少(光标 + 高亮两端 + 几个自动补位置),不用逐字符建 DOM 节点。
 */
type CodeSeg = { start: number; end: number; isTyped: boolean; isHighlight: boolean; isAuto: boolean };
export function codeSegments(
  target: string,
  typedLen: number,
  hl: { start: number; end: number } | null,
  autoAhead?: Iterable<number>,
): CodeSeg[] {
  const marks = new Set<number>([0, target.length]);
  if (typedLen > 0 && typedLen < target.length) marks.add(typedLen);
  if (hl) {
    if (hl.start > 0 && hl.start < target.length) marks.add(hl.start);
    if (hl.end > 0 && hl.end < target.length) marks.add(hl.end);
  }
  // 光标前面的自动补字符已经算「已敲」了,只需要把光标后面那些单独切出来标灰绿。
  const auto = new Set<number>();
  for (const p of autoAhead ?? []) {
    if (p >= typedLen && p < target.length) {
      auto.add(p);
      marks.add(p);
      if (p + 1 < target.length) marks.add(p + 1);
    }
  }
  const points = Array.from(marks).sort((a, b) => a - b);
  const segs: CodeSeg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    segs.push({
      start,
      end,
      isTyped: start < typedLen,
      isHighlight: !!hl && start >= hl.start && end <= hl.end,
      isAuto: auto.has(start) && end === start + 1,
    });
  }
  return segs;
}

/**
 * 在参考代码里定位一个片段:先原样找,找不到就放宽空白(模型偶尔会改缩进/换行)。
 * 找不到返回 null —— 只是不高亮,文字说明照常显示。
 */
export function findSnippet(target: string, snippet: string): { start: number; end: number } | null {
  const s = snippet.trim();
  if (!s) return null;
  const exact = target.indexOf(s);
  if (exact >= 0) return { start: exact, end: exact + s.length };
  const loose = s
    .split(/\s+/)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const m = new RegExp(loose).exec(target);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}
