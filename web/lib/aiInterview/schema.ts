/**
 * 「AI 辅助面试」的共用类型 / 限额 / 入参校验。
 *
 * 这个功能是把桌面版 Cluely 类工具(natively-cluely-ai-assistant)的实时面试 copilot
 * 搬到浏览器里:双通道听(面试官的声音 + 我的麦克风)→ 实时转写 → 检测到面试官在提问就
 * 立刻按简历/JD 生成「可以直接照着说」的答案。
 *
 * 客户端与服务端都会 import 这个文件,所以这里只放纯数据与纯函数,不碰 Node / DOM API。
 */

/* ============================ 模式 / 枚举 ============================ */

export const MODES = ["tech", "behavioral", "coding", "meeting"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, { name: string; desc: string }> = {
  tech: { name: "技术面试", desc: "项目 / 系统设计 / 技术追问,先给结论再给细节" },
  behavioral: { name: "行为面试 BQ", desc: "STAR 结构讲故事,带上简历里的量化结果" },
  coding: { name: "算法 Coding", desc: "思路 + 代码 + 复杂度,可截屏读题" },
  meeting: { name: "普通会议", desc: "会议/电话沟通,简洁的中立回答" },
};

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const STYLES = ["short", "detailed"] as const;
/** short:一两句能马上说出口;detailed:结构完整但仍是口语。 */
export type Style = (typeof STYLES)[number];

export const ROLES = ["interviewer", "me", "assistant"] as const;
export type Role = (typeof ROLES)[number];

/** 一句转写结果。at = 相对开始时间的毫秒偏移(用于排序 / 导出 / 合并相邻句)。 */
export type Turn = { role: Role; text: string; at: number };

export const ANSWER_KINDS = ["answer", "detail", "rephrase", "ask"] as const;
/**
 * answer:正常回答;detail:把上一条答得更细;rephrase:同样内容换个更简单的说法;
 * ask:生成 3 个可以现在反问面试官的问题。
 */
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** 面试官声音的来源:共享标签页音频,或某个输入设备(虚拟声卡 / 会议室麦克风)。 */
export const SOURCE_KINDS = ["display", "device"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/* ============================ 限额 ============================ */

export const LIMITS = {
  resume: 12_000,
  jd: 8_000,
  notes: 2_000,
  company: 120,
  title: 160,
  /** 单句转写文本上限(whisper 对一段 15s 音频不会超过这个量级) */
  turnText: 4_000,
  /** 送进模型的滚动窗口:最多多少句 / 多少字 */
  windowTurns: 60,
  windowChars: 7_000,
  question: 2_000,
  prevAnswer: 4_000,
  /** 一次 PATCH 最多追加多少句 */
  turnsPerPatch: 200,
  audioBytes: 25 * 1024 * 1024, // OpenAI 转写单文件上限
  imageBytes: 8 * 1024 * 1024,
  /**
   * 一次回答的 token 上限。注意推理模型的 max_output_tokens **含推理 token**,
   * 卡太紧会出现「推理用完了、可见文字一个字没出来」,所以留足余量。
   */
  answerTokens: 2_000,
  codingTokens: 5_000,
  summaryTokens: 6_000,
} as const;

/* ============================ 请求体 ============================ */

export type Profile = {
  /** 简历纯文本(从默认简历 / 上传文件 / 粘贴框来) */
  resume: string;
  /** 目标岗位 JD */
  jd: string;
  /** 自己写的备忘:想强调的项目、薪资底线、面试官名字等 */
  notes: string;
  company: string;
};

export type AnswerRequest = {
  mode: Mode;
  lang: Lang;
  style: Style;
  kind: AnswerKind;
  question: string;
  isFollowUp: boolean;
  window: Turn[];
  profile: Profile;
  /** kind=detail / rephrase 时,上一条答案 */
  prevAnswer: string;
};

export type CodingRequest = {
  lang: Lang;
  /** 截屏的 data URL(image/jpeg 或 image/png) */
  image: string;
  /** 从语音里听到的题目补充(可空) */
  question: string;
  window: Turn[];
  profile: Profile;
};

/* ============================ 校验小工具 ============================ */

/** 取字符串并裁到上限;非字符串按空串处理(前端偶发 undefined 不该 500)。 */
export function clip(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const asMode = (v: unknown): Mode => pick(v, MODES, "tech");
export const asLang = (v: unknown): Lang => pick(v, LANGS, "en");
export const asStyle = (v: unknown): Style => pick(v, STYLES, "short");
export const asKind = (v: unknown): AnswerKind => pick(v, ANSWER_KINDS, "answer");
export const asRole = (v: unknown): Role => pick(v, ROLES, "interviewer");

/** 把任意输入整理成合法的 Turn 数组(丢掉空句,只保留最后 max 句)。 */
export function parseTurns(v: unknown, max: number = LIMITS.windowTurns): Turn[] {
  if (!Array.isArray(v)) return [];
  const out: Turn[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { role?: unknown; text?: unknown; at?: unknown };
    const text = clip(r.text, LIMITS.turnText);
    if (!text) continue;
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? Math.max(0, Math.round(r.at)) : 0;
    out.push({ role: asRole(r.role), text, at });
  }
  return out.slice(-max);
}

export function parseProfile(v: unknown): Profile {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    resume: clip(p.resume, LIMITS.resume),
    jd: clip(p.jd, LIMITS.jd),
    notes: clip(p.notes, LIMITS.notes),
    company: clip(p.company, LIMITS.company),
  };
}

export function parseAnswerRequest(body: unknown): AnswerRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    mode: asMode(b.mode),
    lang: asLang(b.lang),
    style: asStyle(b.style),
    kind: asKind(b.kind),
    question: clip(b.question, LIMITS.question),
    isFollowUp: b.isFollowUp === true,
    window: parseTurns(b.window),
    profile: parseProfile(b.profile),
    prevAnswer: clip(b.prevAnswer, LIMITS.prevAnswer),
  };
}

/* ============================ 会话(持久化) ============================ */

export type SessionMeta = {
  id: number;
  title: string;
  mode: Mode;
  lang: Lang;
  company: string;
  turnCount: number;
  hasSummary: boolean;
  startedAt: string;
  endedAt: string | null;
};

export type SessionDetail = SessionMeta & {
  jd: string;
  notes: string;
  summary: string;
  turns: Turn[];
};
