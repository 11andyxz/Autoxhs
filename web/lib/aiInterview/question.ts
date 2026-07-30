import { looksLikeEcho, spanOf } from "./echo";
import { lastInterviewerText } from "./transcript";
import type { Turn } from "./schema";

/**
 * 「面试官是不是在问我问题」的确定性判定(不调模型,纯规则,<1ms)。
 *
 * 为什么不用模型判:每段转写回来都判一次,一分钟十几次,交给模型既慢又贵;
 * 而且判错的代价是「多生成一次答案」或「晚半秒」,规则足够。真正的理解交给回答那一步。
 *
 * 输出的 shouldAnswer 就是自动模式的扣机键:命中才自动生成答案,
 * 寒暄("能听到吗")、我自己在说话、面试官只是"嗯嗯对"都不会触发。
 */

export type QuestionKind =
  | "behavioral" // 讲个经历 / STAR
  | "technical" // 技术概念、项目追问
  | "coding" // 手撕算法 / 复杂度
  | "logistics" // 薪资、时间、签证、你有什么想问我的
  | "smalltalk" // 寒暄、设备确认
  | "unclear";

export type Detected = {
  /** 清理后的问题文本(没检测到就是空串) */
  question: string;
  kind: QuestionKind;
  /** 是不是接着上一个问题的追问(答案里就不必再自我介绍/重复铺垫) */
  isFollowUp: boolean;
  confidence: number;
  /** 是否值得自动生成答案 */
  shouldAnswer: boolean;
};

const NONE: Detected = {
  question: "",
  kind: "unclear",
  isFollowUp: false,
  confidence: 0,
  shouldAnswer: false,
};

/* ---------------------------- 词表 ---------------------------- */

// 口头填充词:转写会老实把它们写下来,清掉能让问题更干净。
const FILLERS =
  /\b(?:um+|uh+|erm+|hmm+|like,|you know,|i mean,|sort of|kind of,|so yeah|okay so|alright so)\b/gi;
const CN_FILLERS = /(?:那个那个|就是就是|嗯+、?|啊+、|呃+、?|然后呢?就是)/g;

// 真疑问词开头:口语里以这些词起头的句子几乎一定是在问你,即使转写没带问号。
const WH_STARTS = /^(?:what|why|how|when|where|which|who|whose|whom)\b/i;
// 助动词 / 命令式提问("tell me about" 也是提问),信号比疑问词弱一档
const EN_QUESTION_STARTS =
  /^(?:can|could|would|will|do|does|did|are|is|was|were|have|has|had|should|shall|may|might|tell|walk|describe|explain|talk|give|share|suppose|imagine|let's|lets|say|assume|any)\b/i;
const EN_QUESTION_PHRASES = [
  "tell me about",
  "walk me through",
  "talk me through",
  "describe a",
  "describe the",
  "give me an example",
  "give an example",
  "explain how",
  "explain what",
  "how would you",
  "how do you",
  "what would you",
  "what's your",
  "what is your",
  "why did you",
  "why do you",
  "have you ever",
  "share an example",
  "let's talk about",
  "i'd like to hear",
  "curious about",
  "questions for me",
  "questions for us",
];

// 中文疑问信号(中文口语常常没有问号)
const CN_QUESTION_PHRASES = [
  "介绍一下",
  "介绍下",
  "说一下",
  "说下",
  "讲一下",
  "讲讲",
  "聊一下",
  "谈谈",
  "举个例子",
  "为什么",
  "怎么样",
  "怎么做",
  "怎么实现",
  "如何",
  "是什么",
  "有没有",
  "能不能",
  "可不可以",
  "你觉得",
  "你认为",
  "有什么想问",
  "还有什么问题",
];
const CN_QUESTION_TAIL = /(?:吗|呢|吧|么)\s*[?？]?$/;

const BEHAVIORAL = [
  "tell me about a time",
  "a time when",
  "give me an example of a time",
  "conflict",
  "disagree",
  "disagreement",
  "difficult",
  "challenge",
  "failure",
  "failed",
  "mistake",
  "weakness",
  "strength",
  "why do you want",
  "why are you looking",
  "why this company",
  "leadership",
  "teamwork",
  "deadline",
  "pressure",
  "自我介绍",
  "介绍一下你自己",
  "为什么想",
  "为什么离职",
  "遇到过",
  "举个例子",
  "最有挑战",
  "冲突",
  "失败",
  "缺点",
  "优点",
  "职业规划",
];

const CODING = [
  "leetcode",
  "implement a function",
  "write a function",
  "write code",
  "code it up",
  "time complexity",
  "space complexity",
  "big o",
  "brute force",
  "two pointer",
  "binary search",
  "linked list",
  "binary tree",
  "dynamic programming",
  "the array",
  "the string",
  "share your screen and code",
  "手撕",
  "写个函数",
  "写一下代码",
  "时间复杂度",
  "空间复杂度",
  "算法题",
  "这道题",
];

const LOGISTICS = [
  "salary",
  "compensation",
  "expectation",
  "notice period",
  "start date",
  "visa",
  "sponsorship",
  "relocate",
  "relocation",
  "remote",
  "onsite",
  "availability",
  "questions for me",
  "questions for us",
  "薪资",
  "期望薪水",
  "什么时候能入职",
  "签证",
  "身份",
  "远程",
  "到岗",
  "想问我",
  "想问的",
];

const SMALLTALK = [
  "can you hear me",
  "can you see my screen",
  "are you there",
  "how are you",
  "how's it going",
  "how are you doing",
  "nice to meet you",
  "good morning",
  "good afternoon",
  "thanks for joining",
  "thank you for joining",
  "let me share my screen",
  "give me one second",
  "one moment",
  "听得到吗",
  "能听到吗",
  "看得到吗",
  "能看到我屏幕吗",
  "你好",
  "早上好",
  "下午好",
  "稍等",
  "等我一下",
];

// 面试官只是在附和,不是在问
const ACK = /^(?:ok(?:ay)?|got it|i see|right|sure|yeah|yep|uh huh|mm+|cool|great|perfect|nice|thanks?|thank you|makes sense|好的?|嗯+|对|行|可以|明白|了解|不错|谢谢)[\s.!,。!,]*$/i;

const FOLLOWUP_STARTS =
  /^(?:and|so|but|then|also|what about|how about|why|why not|can you elaborate|could you elaborate|elaborate|in that case|besides that|anything else|那|那么|那你|然后呢?|还有呢?|接着|除此之外|再具体|具体点|具体一点|能再|继续)\b/i;

const TECH_TERMS =
  /\b(?:java|spring|kafka|redis|mysql|postgres|sql|nosql|mongodb|docker|kubernetes|k8s|aws|gcp|azure|react|node|python|golang|go|rust|api|rest|grpc|graphql|microservice|micro-?services?|thread|threads|concurrency|lock|transaction|acid|index|indexes|cache|caching|queue|latency|throughput|scal(?:e|ing|ability)|shard|sharding|replica|replication|design|architecture|jvm|gc|garbage collection|hashmap|jpa|hibernate|ci\/cd|jenkins|terraform|oauth|jwt|websocket|memory leak|deadlock|race condition)\b/i;

/* ---------------------------- 工具 ---------------------------- */

function clean(raw: string): string {
  return raw
    .replace(FILLERS, " ")
    .replace(CN_FILLERS, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.、,。]+/, "")
    .trim();
}

// 口语里几乎每句都从这些词起头("So walk me through…"),它们会挡住「疑问词开头」的判断。
const LEAD = /^(?:so|and|but|okay|ok|alright|all right|now|then|well|yeah|yep|hey|hi|hello|right|cool|great)[\s,.:;、,。]+/i;

/** 去掉句首的语气/连接词,只为判断「是不是疑问词开头」(不改用于展示的问题文本)。 */
function stripLead(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEAD, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function hits(text: string, list: string[]): boolean {
  return list.some((p) => text.includes(p));
}

function wordCount(text: string): number {
  const en = text.split(/\s+/).filter(Boolean).length;
  const cn = (text.match(/[一-鿿]/g) || []).length;
  // 中文按 1.6 字 ≈ 1 词粗算,让长度门槛对两种语言都成立。
  return cn > 0 ? Math.max(en, Math.round(cn / 1.6)) : en;
}

/** 说一段话大概要多久(粗估:中文约 200ms/字,英文约 55ms/字符) */
function estimateSpokenMs(text: string): number {
  const cn = (text.match(/[一-鿿]/g) || []).length;
  return cn * 200 + (text.length - cn) * 55;
}

/**
 * 面试官最后连着说的几句(VAD 已按停顿切段,这里再看语义上要不要一起看)。
 *
 * **只合并时间上真的挨着的段**:一句问题常被切成两三段(中间只隔几百毫秒),那要合起来看;
 * 但上一道题和这一道题之间隔着几十秒,绝不能粘在一起 —— 实测粘过一次,发给模型的问题变成
 * 「Hi Andy, thanks for making the time today.(第 6 秒) How do you keep a Kafka consumer…(第 79 秒)」。
 */
const JOIN_GAP_MS = 4_000;

function tailInterviewerText(turns: Turn[], maxJoin = 2): string {
  const picked: Turn[] = [];
  for (let i = turns.length - 1; i >= 0 && picked.length < maxJoin; i -= 1) {
    const t = turns[i];
    if (t.role !== "interviewer") break; // 遇到「我」说的话就停:那之后是新一轮
    const next = picked[0];
    if (next) {
      const gap = next.at - (t.at + estimateSpokenMs(t.text));
      if (gap > JOIN_GAP_MS) break; // 隔太久 = 另一个问题,别粘
    }
    picked.unshift(t);
  }
  return picked.map((t) => t.text).join(" ").trim() || lastInterviewerText(turns);
}

/**
 * 从最后一句往前看:面试官那一轮之后,我有没有真的开口回答?
 * 不算数的:①扬声器回声(和面试官同时、内容相同) ②「嗯 / 对 / okay」这类附和。
 */
function userAlreadyAnswering(turns: Turn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.role === "interviewer") return false; // 走到面试官那一句了,说明我还没开口
    if (t.role !== "me") continue; // assistant(建议答案)不算
    if (ACK.test(clean(t.text))) continue;
    if (looksLikeEcho(t, turns)) continue;
    // 和面试官这句话时间上大幅重叠、又不像回声(内容不同)→ 是插话,给它算作在答
    if (wordCount(clean(t.text)) >= 2) return true;
  }
  return false;
}

function classify(text: string): QuestionKind {
  const t = text.toLowerCase();
  if (hits(t, CODING)) return "coding";
  if (hits(t, BEHAVIORAL)) return "behavioral";
  if (hits(t, LOGISTICS)) return "logistics";
  if (TECH_TERMS.test(t)) return "technical";
  return "technical";
}

/* ---------------------------- 主判定 ---------------------------- */

/**
 * 看字幕窗口的尾巴,判断面试官是否刚问了一个该回答的问题。
 * prevQuestion 传上一次已经回答过的问题,用来判断这次是不是追问。
 */
export function detectQuestion(turns: Turn[], prevQuestion = ""): Detected {
  if (!turns.length) return NONE;

  // 我已经在答了 → 不抢话。
  // 注意不能简单地看「最后一句是不是面试官」:外放(不戴耳机)时面试官的声音会被麦克风
  // 录一遍,尾巴永远是「我」,那样就再也不会自动生成答案了(实测过)。所以这里要
  // 排掉「回声」和「嗯/对」这类附和,只有真的开口答了才让路。
  if (userAlreadyAnswering(turns)) return NONE;

  const raw = tailInterviewerText(turns);
  const text = clean(raw);
  if (!text) return NONE;

  if (ACK.test(text)) return { ...NONE, question: text, kind: "smalltalk" };

  const lower = text.toLowerCase();
  const words = wordCount(text);

  // 用整数分累加(0~100)再折成 0~1:浮点相加会出现 0.44999… 这种刚好卡在门槛下的意外。
  let points = 0;
  const lead = stripLead(lower);
  if (/[?？]\s*$/.test(text)) points += 50;
  // 疑问词开头单独就够触发:实测「and why not just use Redis for that.」这种追问,
  // 转写常常不带问号、又只有七八个词,按 30 分算会低于门槛,答案就不生成了。
  if (WH_STARTS.test(lead)) points += 45;
  else if (EN_QUESTION_STARTS.test(lead)) points += 30;
  if (hits(lower, EN_QUESTION_PHRASES)) points += 40;
  // 中文口语基本不带问号,短语本身就是最强的信号。
  if (hits(text, CN_QUESTION_PHRASES)) points += 50;
  if (CN_QUESTION_TAIL.test(text)) points += 25;
  // 够长的一段话即使没有疑问标记,通常也是在给你一个题目 / 场景。
  if (words >= 12) points += 15;
  if (words < 3) points -= 30;

  const smalltalk = hits(lower, SMALLTALK);
  if (smalltalk) points -= 50;

  const confidence = Math.max(0, Math.min(100, points)) / 100;

  const kind: QuestionKind = smalltalk ? "smalltalk" : classify(text);
  const isFollowUp =
    (FOLLOWUP_STARTS.test(lower) || words <= 7) &&
    !!prevQuestion &&
    prevQuestion.trim() !== text;

  const shouldAnswer = confidence >= 0.45 && kind !== "smalltalk" && words >= 3;

  return { question: text, kind, isFollowUp, confidence, shouldAnswer };
}
