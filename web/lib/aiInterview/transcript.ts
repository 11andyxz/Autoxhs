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
