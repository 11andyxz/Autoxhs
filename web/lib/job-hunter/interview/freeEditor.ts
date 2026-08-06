/**
 * 「面试模式」自由手写代码时的编辑器按键处理(纯函数,套在一个 textarea 上)。
 *
 * 和跟打训练那套(typing.ts)完全不同:跟打有标准答案兜底,「已敲内容永远是目标代码的前缀」;
 * 这里没有答案,用户想写什么写什么,所以只能做通用 IDE 手感 —— 自动补括号、跳过闭括号、
 * 回车继承缩进、Tab 打空格。
 *
 * 每个函数要么返回新的 {value, cursor},要么返回 null 表示「这一下我不管,交给浏览器默认行为」。
 */

export type EditResult = { value: string; cursor: number };

/** 开括号 → 闭括号。引号自己配自己。 */
export const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

/** 能被「跳过去」的闭合符。 */
export const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);

/** 一级缩进 = 4 个空格(和跟打题库、AI 出的代码同口径,别用 Tab)。 */
export const INDENT = "    ";

/** pos 所在行的行首下标。 */
export function lineStart(value: string, pos: number): number {
  const i = value.lastIndexOf("\n", Math.max(0, pos - 1));
  return i < 0 ? 0 : i + 1;
}

/** pos 所在行开头的空白(缩进)。 */
export function indentOf(value: string, pos: number): string {
  const start = lineStart(value, pos);
  const line = value.slice(start, pos);
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}

const splice = (value: string, start: number, end: number, insert: string): string =>
  value.slice(0, start) + insert + value.slice(end);

/**
 * Tab:没选区就打一级缩进;有选区就把整选区每行往右推一级。
 * (textarea 默认 Tab 会跳走焦点 —— 写代码时这是最烦的一件事。)
 */
export function handleTab(value: string, start: number, end: number, shift = false): EditResult {
  if (start === end && !shift) {
    return { value: splice(value, start, end, INDENT), cursor: start + INDENT.length };
  }
  const from = lineStart(value, start);
  const to = end;
  const block = value.slice(from, to);
  const lines = block.split("\n");
  if (shift) {
    const outdented = lines.map((l) => (l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^[ \t]+/, "")));
    const next = outdented.join("\n");
    return { value: splice(value, from, to, next), cursor: from + next.length };
  }
  const next = lines.map((l) => INDENT + l).join("\n");
  return { value: splice(value, from, to, next), cursor: from + next.length };
}

/**
 * 回车:继承本行缩进;光标正好夹在一对括号中间(`{|}`)时,展开成三行并把闭括号放到对齐的下一行;
 * 行尾是开括号时多缩进一级。
 */
export function handleEnter(value: string, start: number, end: number): EditResult {
  const indent = indentOf(value, start);
  const before = value.slice(0, start);
  const prevChar = before.slice(-1);
  const nextChar = value.slice(end, end + 1);
  const opensBlock = prevChar === "{" || prevChar === "(" || prevChar === "[";
  const inner = opensBlock ? indent + INDENT : indent;

  // `{|}` → 换两行,闭括号回到原缩进
  if (opensBlock && nextChar === PAIRS[prevChar]) {
    const insert = `\n${inner}\n${indent}`;
    return { value: splice(value, start, end, insert), cursor: start + 1 + inner.length };
  }
  const insert = `\n${inner}`;
  return { value: splice(value, start, end, insert), cursor: start + insert.length };
}

/**
 * 敲开括号/引号:自动补上配对的闭合符,光标停在中间。
 * 有选区时是「用括号把选中的代码包起来」(和 IDE 一致)。
 * 引号只在「右边不是字母数字」时才自动配对 —— 否则在 `don|t` 里敲 ' 会平白多出一个。
 */
export function handleOpen(value: string, start: number, end: number, ch: string): EditResult | null {
  const close = PAIRS[ch];
  if (!close) return null;
  if (start !== end) {
    const selected = value.slice(start, end);
    return { value: splice(value, start, end, ch + selected + close), cursor: end + 2 };
  }
  const nextChar = value.slice(start, start + 1);
  if (/[\w$]/.test(nextChar)) return null; // 右边紧挨着标识符,不补
  if (ch === close) {
    // 引号:左边也紧挨着标识符就不补(`it's` 这种)
    const prevChar = value.slice(Math.max(0, start - 1), start);
    if (/[\w$]/.test(prevChar)) return null;
  }
  return { value: splice(value, start, end, ch + close), cursor: start + 1 };
}

/** 敲闭合符:右边正好就是它 → 跳过去(别多打一个)。否则 null,照常输入。 */
export function handleCloser(value: string, start: number, end: number, ch: string): EditResult | null {
  if (start !== end || !CLOSERS.has(ch)) return null;
  if (value.slice(start, start + 1) !== ch) return null;
  return { value, cursor: start + 1 };
}

/** 退格:光标夹在一对空括号/空引号中间 → 一次删掉两个。 */
export function handleBackspace(value: string, start: number, end: number): EditResult | null {
  if (start !== end || start === 0) return null;
  const prev = value.slice(start - 1, start);
  const next = value.slice(start, start + 1);
  if (PAIRS[prev] && PAIRS[prev] === next) {
    return { value: splice(value, start - 1, start + 1, ""), cursor: start - 1 };
  }
  return null;
}

/**
 * 总入口:按下某个键要怎么改文本。返回 null = 不接管,让浏览器按默认行为处理。
 * 调用方负责 preventDefault + 设置 selectionRange。
 */
export function applyEditorKey(
  value: string,
  start: number,
  end: number,
  key: string,
  opts: { shift?: boolean } = {},
): EditResult | null {
  if (key === "Tab") return handleTab(value, start, end, opts.shift);
  if (key === "Enter") return handleEnter(value, start, end);
  if (key === "Backspace") return handleBackspace(value, start, end);
  if (key.length !== 1) return null;
  if (PAIRS[key]) {
    // 引号既是开也是闭:先试「跳过去」,不行再试「补一对」。
    if (CLOSERS.has(key)) {
      const skip = handleCloser(value, start, end, key);
      if (skip) return skip;
    }
    return handleOpen(value, start, end, key);
  }
  if (CLOSERS.has(key)) return handleCloser(value, start, end, key);
  return null;
}
