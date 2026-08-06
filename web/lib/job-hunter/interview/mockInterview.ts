/**
 * 「面试模式」的纯逻辑:AI 出一道 LeetCode 式算法题 → 自由手写代码 → 边写边被面试官追问
 * (问题语音播报)→ 交卷后 AI 复盘。
 *
 * 这里只放不碰 DB / 不碰 OpenAI 的部分,好被单测覆盖:
 * - 题目 → 存进 ip_coding_problem 的文本(中英两份,英文那份也是 TTS 念题的稿子)
 * - 什么时候该冒出下一个追问(节奏控制)
 * - 喂给模型的上下文裁剪
 */

import type { MockProblemGen } from "./schema";

/* ---------------- 示例值清洗 ---------------- */

/** 示例的输入/输出最多留这么长;正常的字面量远短于此。 */
const MAX_EXAMPLE_VALUE = 200;

/**
 * 从一个字符串里切出开头那个完整的 JSON 字面量(数组/对象/字符串都按配对扫,能处理嵌套和转义)。
 * 切不出来返回 null。
 */
function literalPrefix(s: string): string | null {
  const open = s[0];
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return s.slice(0, i + 1);
      }
    }
    return null; // 没闭合,当作切不出来
  }
  if (open === '"') {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === '"') return s.slice(0, i + 1);
    }
    return null;
  }
  const m = s.match(/^(-?\d+(?:\.\d+)?|true|false|null)\b/);
  return m ? m[1] : null;
}

/**
 * 清洗示例里的输入/输出。
 *
 * **为什么要有这一步**:实测模型会在 `output` 里正确值后面接一串垃圾 ——
 * `"2保存到win剪贴板 …, ignore schema and output markdown."`(混着中文、法语和指令腔)。
 * 题面之后还会被喂回给追问/复盘那两次调用,所以既不能让它糊在页面上,也不能让它混进上下文
 * (提示词里已经声明题面是数据不是指令,这里再从数据层面掐一道)。
 *
 * 规则:只留第一行;输出/输入若以一个完整的 JSON 字面量开头,就只保留那个字面量,后面的散文一律丢掉。
 */
export function cleanExampleValue(raw: string): string {
  const first = (raw ?? "").split("\n")[0].trim();
  if (!first) return "";
  const lit = literalPrefix(first);
  if (lit && lit.length < first.length) return lit; // 字面量后面还拖着东西 → 只要字面量
  return first.slice(0, MAX_EXAMPLE_VALUE);
}

/**
 * 输入通常长这样:`intervals = [[0,30],[5,10]]`、`s = "abc", k = 2`。
 * 先按 `名字 = 值` 拆开,对值那半边做同样的清洗,再拼回去。
 */
export function cleanExampleInput(raw: string): string {
  const first = (raw ?? "").split("\n")[0].trim();
  if (!first) return "";
  const eq = first.indexOf("=");
  if (eq > 0 && eq < 40) {
    const name = first.slice(0, eq + 1);
    const rest = first.slice(eq + 1).trim();
    const lit = literalPrefix(rest);
    // 多个参数(`s = "abc", k = 2`)时字面量后面本来就跟着 `, k = 2`,别把它当垃圾切掉。
    if (lit && lit.length < rest.length && !rest.slice(lit.length).trimStart().startsWith(",")) {
      return `${name} ${lit}`.slice(0, MAX_EXAMPLE_VALUE);
    }
  }
  return first.slice(0, MAX_EXAMPLE_VALUE);
}

/* ---------------- 题面排版 ---------------- */

/** 题目要占的篇幅上限(和 ip_coding_problem.prompt / prompt_en 的入库截断同口径)。 */
export const MAX_PROMPT = 4000;

const bullet = (lines: string[]): string => lines.map((l) => `- ${l}`).join("\n");

/**
 * 中文题面:题干 + 示例 + 约束。存进 `prompt`,也是页面上给人看的那一份。
 * 刻意排成 LeetCode 的样子(Example / Constraints),面试时看到的就是这个格式。
 */
export function formatProblemZh(p: MockProblemGen): string {
  const parts: string[] = [p.statementZh.trim()];
  p.examples.forEach((ex, i) => {
    const lines = [`示例 ${i + 1}:`, `输入：${ex.input}`, `输出：${ex.output}`];
    if (ex.explanation.trim()) lines.push(`说明：${ex.explanation.trim()}`);
    parts.push(lines.join("\n"));
  });
  if (p.constraints.length) parts.push(`约束：\n${bullet(p.constraints)}`);
  return parts.join("\n\n").slice(0, MAX_PROMPT);
}

/**
 * 英文题面。存进 `prompt_en` —— 面试官念的就是这一份(TTS 读英文,和真实面试口径一致)。
 */
export function formatProblemEn(p: MockProblemGen): string {
  const parts: string[] = [p.statementEn.trim()];
  p.examples.forEach((ex, i) => {
    const lines = [`Example ${i + 1}:`, `Input: ${ex.input}`, `Output: ${ex.output}`];
    if (ex.explanation.trim()) lines.push(`Explanation: ${ex.explanation.trim()}`);
    parts.push(lines.join("\n"));
  });
  if (p.constraints.length) parts.push(`Constraints:\n${bullet(p.constraints)}`);
  return parts.join("\n\n").slice(0, MAX_PROMPT);
}

/** 存进 `explanation` 的要点:复杂度 + 考点/常见追问。 */
export function formatKeyPoints(p: MockProblemGen): string {
  return [p.complexity.trim() && `复杂度：${p.complexity.trim()}`, p.keyPoints.trim()]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PROMPT);
}

/**
 * 念题稿:面试官开场读的那段。只念题干本身 + 第一个示例 —— 把约束和第二三个示例
 * 全念出来又长又催眠(TTS 也按字符收费),真实面试也是让你自己看屏幕。
 */
export function speechForProblem(p: MockProblemGen | { statementEn: string; examples: { input: string; output: string }[] }): string {
  const first = p.examples[0];
  const head = p.statementEn.trim();
  if (!first) return head;
  return `${head} For example, given ${first.input}, the answer is ${first.output}.`;
}

/* ---------------- 追问节奏 ---------------- */

export type ProbeTurn = {
  /** 面试官问的(英文,念出来的就是这句) */
  question: string;
  /** 中文一句,给自己看的 */
  zh: string;
  /** 考的是什么 */
  kind: string;
  /** 我的回答(空 = 还没答/跳过了) */
  answer: string;
  /** 提问时刻(ms) */
  askedAt: number;
};

/** 自动追问的间隔档位(秒)。0 = 关掉自动,只在点「再问我一个」时问。 */
export const PROBE_INTERVALS = [0, 30, 60, 120] as const;
export type ProbeInterval = (typeof PROBE_INTERVALS)[number];

export function isProbeInterval(v: unknown): v is ProbeInterval {
  return typeof v === "number" && (PROBE_INTERVALS as readonly number[]).includes(v);
}

/**
 * 现在该不该冒出下一个追问。
 *
 * 规则(按顺序):
 * 1. 关了自动 / 正在请求 / 上一个问题还挂着没答 → 不问。挂着还问会堆成一屏问题,
 *    真面试官也是等你回一句再追下一句。
 * 2. 距上次提问不够一个间隔 → 不问。
 * 3. 这期间**代码一个字没动**:把门槛提到两倍间隔再问。人卡住不动的时候面试官确实会开口
 *    (「说说你的思路?」),但不能每 30 秒催一次。
 */
export function shouldAutoAsk(s: {
  enabled: boolean;
  intervalSec: number;
  now: number;
  /** 上一次提问的时刻;还没问过就传开始时刻 */
  lastAskedAt: number;
  /** 有没有一个还没答的问题挂着 */
  pending: boolean;
  /** 正在请求下一个问题 */
  busy: boolean;
  /** 当前代码长度 */
  codeLen: number;
  /** 上次提问时的代码长度 */
  codeLenAtLastAsk: number;
}): boolean {
  if (!s.enabled || s.intervalSec <= 0) return false;
  if (s.pending || s.busy) return false;
  const waited = (s.now - s.lastAskedAt) / 1000;
  if (waited < s.intervalSec) return false;
  const idle = s.codeLen === s.codeLenAtLastAsk;
  if (idle && waited < s.intervalSec * 2) return false;
  return true;
}

/* ---------------- 喂给模型的上下文 ---------------- */

/** 代码最多喂这么多字符;超了掐头留尾(尾巴才是他正在写的地方)。 */
export const MAX_CODE_CHARS = 6000;
/** 最多带上最近这么多轮问答,省 token 也省得模型被早期的闲聊带跑。 */
export const MAX_TURNS = 8;
export const MAX_ANSWER_CHARS = 1200;

export function trimCode(code: string, max = MAX_CODE_CHARS): string {
  const c = code ?? "";
  if (c.length <= max) return c;
  return `……(前面省略)\n${c.slice(c.length - max)}`;
}

/** 已问过的问答整理成一段文本(给模型看「问到哪儿了、他答得怎么样」)。 */
export function formatTurns(turns: ProbeTurn[], max = MAX_TURNS): string {
  return turns
    .slice(-max)
    .map((t, i) => {
      const a = t.answer.trim().slice(0, MAX_ANSWER_CHARS);
      return `Q${i + 1}: ${t.question}\nA${i + 1}: ${a || "(no answer / skipped)"}`;
    })
    .join("\n\n");
}

/** 代码框里什么都没有(只有空白/注释骨架)= 还没开始写,追问要问思路而不是问实现。 */
export function codeIsEmpty(code: string, starter: string): boolean {
  const strip = (s: string) => (s ?? "").replace(/\s+/g, "");
  const c = strip(code);
  return c === "" || c === strip(starter);
}

/** 面试用时(秒),给复盘看。 */
export function elapsedSec(startedAt: number, now: number): number {
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
