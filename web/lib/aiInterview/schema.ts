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

/**
 * 回答语言:
 *  - en    纯英文(干净,英文面试直接照读)
 *  - en-zh 英文面试 + 中文速读:上面一行中文骨架(术语保持英文)让你一眼读懂,下面英文照着说
 *  - zh    中文面试(答案就是要说的话,技术术语仍保持英文)
 */
export const LANGS = ["en", "en-zh", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, { name: string; desc: string }> = {
  en: { name: "English", desc: "纯英文,直接照读" },
  "en-zh": { name: "英文 + 中文速读", desc: "中文抓逻辑,英文照着说" },
  zh: { name: "中文", desc: "中文面试;术语保留英文" },
};

/**
 * 转写接口要的 ISO-639-1 两位码。en-zh 的**音频是英文**,别把 "en-zh" 直接传过去
 * (那样正则校验不过,会退化成自动识别,反而更容易听错)。
 */
export function transcribeLang(lang: Lang): "en" | "zh" {
  return lang === "zh" ? "zh" : "en";
}

/** 这个语言设定是不是「中文速读 + 英文照说」的双层输出 */
export function isLayered(lang: Lang): boolean {
  return lang === "en-zh";
}

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

/**
 * 面试官声音的来源:共享标签页音频、某个输入设备(虚拟声卡)、或本机辅助程序抓系统声音。
 * helper 那条路见 tools/mac-audio-helper(桌面版 Zoom / Teams 用它)。
 */
export const SOURCE_KINDS = ["display", "device", "helper"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/* ============================ 限额 ============================ */

export const LIMITS = {
  /**
   * 简历字数上限。**这个值会静默截断,别当成"随便设个大点的数"**。
   *
   * 2026-07-31:桌面端结构化出来的简历 `education: []`、experience 只有 2 段,查到根因是
   * 这里 —— 用户 6 页的简历提取出来 24,234 字,经 `/resume-text` 和快照 clip 到 12,000 后
   * 同步给桌面端,后半截(含 EDUCATION 整节、以及 Anthropic / Claude / vector 这些正好被
   * 面试官问到的词)从来没有到过模型面前。截断点在词中间,两端都没有任何提示。
   *
   * 和桌面端 `profileStore.MAX_RESUME_CHARS` 保持一致 —— 两边不一致时,小的那个会悄悄
   * 决定另一边能看到多少。40k ≈ 10 页密排文本,真实简历不会触发;它防的是整本书粘进来。
   */
  resume: 40_000,
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

/* ============================ 副屏 / 手机查看 ============================ */

/**
 * 推给副屏(手机 / iPad / 第二显示器)的一帧状态快照。
 * 走「整份快照」而不是增量:副屏只要渲染最新一帧,两端不需要任何合并/排序逻辑,
 * 掉一帧也自动被下一帧纠正。
 */
export type LiveState = {
  /** 递增版本号,只在变化时推 */
  v: number;
  /** 生成这帧的服务端时间(ms),副屏用它判断是不是卡住了 */
  at: number;
  live: boolean;
  company: string;
  mode: Mode;
  elapsedMs: number;
  question: string;
  questionKind: string;
  /**
   * 正在说、还没定稿的那句(interim)。和 `question` 分开:`question` 是「当前这个答案
   * 是针对哪一问生成的」,必须稳定;`partial` 是「对方此刻正在说什么」,一直在变。
   * 桌面端的悬浮窗本来就是这么分的(上游 sendThrottledTranscript 送的就是它),
   * 手机上以前没有,所以对方说话时那半分钟屏幕是死的。
   */
  partial: string;
  confidence: number;
  /** 面板标题:建议这样说 / 说得更细 / 截屏解题 … */
  label: string;
  /**
   * 这版答案处于哪个阶段。两阶段回答(Quick Draft → Final Answer):
   *   'draft' —— 面试官还没说完时先算的一版,只有核心思路,**会被顶掉**
   *   'final' —— 用完整问题 + 简历生成的正式答案
   * 上游本来就在算 draft(IntelligenceEngine.maybeSpeculate),只是结果进了缓存不给人看;
   * 这个字段把它显形,让人一眼知道屏幕上这版还会不会变。
   */
  answerStage: "" | "draft" | "final";
  answer: string;
  streaming: boolean;
  /** 采集是否中断了(辅助程序被系统掐断 / 共享被停) —— 副屏要看得见,别以为一切正常 */
  sourceDown: boolean;
  /**
   * 有多少段音频最终没转写成功(重试后仍失败)。
   * 必须推到副屏:实测过「面试官的问题被自家限流 429 掉」,Mac 上弹了红条,
   * 但人在看手机,完全不知道自己正在聋着。
   */
  sttFailed: number;
  /**
   * 「完美答案」的状态。
   *
   * 截图解题时,第一版答案是模型直接看题写的;桌面端随后在**后台**把代码丢进沙箱
   * 跑测试用例(natively 自带 electron/llm/codeVerification),跑完可能给出一版
   * 纠正后的代码。副屏上那个按钮就是这件事的进度:
   *   none     不是代码题 / 没在验
   *   running  正在跑用例(按钮置灰)
   *   already  第一版本身就全过了(不需要改)
   *   ready    有纠正版了(按钮高亮,点开看 diff)
   *
   * 为什么值得单独一档而不是直接替换答案:面试时把答案悄悄换掉,人是懵的;
   * 分两步 + diff 高亮,既能看出改了哪儿,过程本身看起来也像在思考。
   */
  /**
   * 桌面端当前的失败原因,空串表示一切正常。
   *
   * 为什么必须有这个字段:在它存在之前,答案生成失败、STT 掉线、发布权被抢、重试
   * 耗尽 —— 全部长得一模一样,就是「屏幕不动了」。用户在面试中间盯着一个静止的
   * 页面,唯一能做的判断是「它是不是死了」,而这恰恰是最没用的信息。
   * 桌面端有 lastError,以前只留在 getStatus()(手机看不到)。
   */
  error: string;
  perfectState: "none" | "running" | "already" | "ready" | "skipped";
  /** 纠正后的完整答案(state=ready 时才有) */
  perfectAnswer: string;
  /** 一句话说明哪里错了 / 或「N/N 用例通过」 */
  perfectNote: string;
  /** 最近几句字幕(倒数在后) */
  transcript: Turn[];
};

export const EMPTY_LIVE_STATE: LiveState = {
  v: 0,
  at: 0,
  live: false,
  company: "",
  mode: "tech",
  elapsedMs: 0,
  question: "",
  partial: "",
  questionKind: "",
  confidence: 0,
  answerStage: "",
  label: "",
  answer: "",
  streaming: false,
  sourceDown: false,
  sttFailed: 0,
  error: "",
  perfectState: "none",
  perfectAnswer: "",
  perfectNote: "",
  transcript: [],
};

/** questionKind 的合法取值。空串 = 未分类。 */
const KNOWN_QUESTION_KINDS = new Set(["", "behavioral", "technical", "coding", "system_design", "followup"]);

/** 副屏快照里最多带几句字幕 */
export const LIVE_TRANSCRIPT_TURNS = 8;

/** 把任意输入整理成一帧合法快照(v / at 由服务端盖) */
export function parseLiveState(v: unknown): Omit<LiveState, "v" | "at"> {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    live: b.live === true,
    company: clip(b.company, LIMITS.company),
    mode: asMode(b.mode),
    elapsedMs:
      typeof b.elapsedMs === "number" && Number.isFinite(b.elapsedMs)
        ? Math.max(0, Math.round(b.elapsedMs))
        : 0,
    question: clip(b.question, LIMITS.question),
    // 白名单而不是 clip:这个值在手机上被当作对象 key 查表(KIND_LABEL[kind]),
    // 一个 "__proto__" 之类的字符串取出来的是函数/对象,渲染成 React 子节点会抛。
    partial: clip(b.partial, LIMITS.question),
    questionKind: KNOWN_QUESTION_KINDS.has(String(b.questionKind ?? ""))
      ? String(b.questionKind)
      : "",
    confidence:
      typeof b.confidence === "number" && Number.isFinite(b.confidence)
        ? Math.min(1, Math.max(0, b.confidence))
        : 0,
    label: clip(b.label, 32),
    answerStage: b.answerStage === "draft" || b.answerStage === "final" ? b.answerStage : "",
    answer: clip(b.answer, LIMITS.prevAnswer),
    streaming: b.streaming === true,
    sourceDown: b.sourceDown === true,
    error: clip(b.error, 200),
    perfectState:
      b.perfectState === "running" || b.perfectState === "already"
      || b.perfectState === "ready" || b.perfectState === "skipped"
        ? b.perfectState
        : "none",
    perfectAnswer: clip(b.perfectAnswer, LIMITS.prevAnswer),
    perfectNote: clip(b.perfectNote, 200),
    sttFailed:
      typeof b.sttFailed === "number" && Number.isFinite(b.sttFailed)
        ? Math.max(0, Math.round(b.sttFailed))
        : 0,
    transcript: parseTurns(b.transcript, LIVE_TRANSCRIPT_TURNS),
  };
}

export type SessionDetail = SessionMeta & {
  jd: string;
  notes: string;
  summary: string;
  turns: Turn[];
};
