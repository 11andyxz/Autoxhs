/**
 * 每天的选题排期：一次生成当天 24 个主题，落进 xhs_auto_post 的 24 个整点。
 *
 * 去重靠两层：
 *  1) 生成时把最近用过的主题喂给模型，明确要求避开；
 *  2) 入库时 topic_key 全表唯一（INSERT IGNORE）—— 模型忘了也漏不进去。
 * 因此「插进去的条数 < 要的条数」是正常现象，补一轮即可。
 *
 * 生成时机是**懒触发**：当天第一次跑到、发现还没排就现排。
 * 不挑固定时辰，机器那会儿关着也不会漏 —— 开机后第一轮自然把当天排出来。
 */

import { getClient, getModel } from "@/lib/openai";

import { SLOTS_PER_DAY, countPlanned, insertPlan, recentTopics, usedSlots } from "./db";

const TIMEOUT_MS = 120_000;
/** 每次向模型多要几个，抵掉入库时被 topic_key 撞掉的部分 */
const OVERASK = 8;
const MAX_ROUNDS = 3;

const TOPICS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: {
    topics: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

function buildPrompt(theme: string, need: number, avoid: string[]): string {
  const avoidBlock = avoid.length
    ? `\n\n【已经发过或已排期的主题，全部避开，也不要只换个说法】\n${avoid.map((t) => `- ${t}`).join("\n")}`
    : "";
  return `为一个面向美国留学生的小红书账号，规划 ${need} 个**互不重复**的笔记主题。

领域：${theme}

每个主题的要求：
- 8~16 个中文字符，是一个具体问题或具体场景，不是宽泛大词（✅「OPT失业期怎么算」；❌「OPT那些事」）
- 覆盖不同角度：时间线/申请步骤/材料/失业期/换工作/身份衔接/延期/常见拒因/时间点风险/实操细节
- 读者一看就知道这篇解决他哪个具体麻烦
- 不要出现夸张承诺、不要「保过」「内推」这类字眼
- 只写主题本身，不要编号、不要引号、不要标点结尾${avoidBlock}

只输出 JSON：{"topics":["...", "..."]}`;
}

async function askTopics(theme: string, need: number, avoid: string[]): Promise<string[]> {
  const client = getClient(TIMEOUT_MS, 0);
  const response = await client.responses.create({
    model: getModel(),
    input: [{ role: "user", content: buildPrompt(theme, need, avoid) }],
    text: {
      format: {
        type: "json_schema",
        name: "xhs_auto_post_topics",
        strict: true,
        schema: TOPICS_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
  const text = response.output_text;
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const raw = (json as { topics?: unknown }).topics;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().replace(/^[\d.、)）\s-]+/, "").replace(/[。.]$/, ""))
    .filter((t) => t.length >= 4 && t.length <= 40);
}

export type PlanResult = { created: number; total: number; rounds: number };

/**
 * 确保 date 这天排好主题（已排的不动）。返回新排进去多少。
 *
 * `fromSlot` = 从哪个整点开始排，调用方传「当前小时」。这一点很关键：
 * 中午 12 点才第一次排今天的期，如果从 0 点开始排，0~11 点这 12 个整点一落库就全部「已到点」，
 * 下一轮就会连珠炮似地补发 —— 那正是触发风控的方式。所以**只排当前小时往后的整点**，
 * 「补跑」只补那些**曾经排好、却因为关机错过**的整点。
 */
export async function ensureDailyPlan(
  date: string,
  opts: { theme: string; count?: number; fromSlot?: number; log?: (m: string) => void },
): Promise<PlanResult> {
  const log = opts.log ?? (() => {});
  const firstSlot = Math.min(SLOTS_PER_DAY - 1, Math.max(0, Math.floor(opts.fromSlot ?? 0)));
  const capacity = SLOTS_PER_DAY - firstSlot;
  const want = Math.min(capacity, Math.max(1, opts.count ?? SLOTS_PER_DAY));

  let planned = await countPlanned(date);
  if (planned >= want) return { created: 0, total: planned, rounds: 0 };

  const avoid = await recentTopics(300);
  let created = 0;
  let rounds = 0;

  while (planned < want && rounds < MAX_ROUNDS) {
    rounds += 1;
    const need = want - planned;
    const candidates = await askTopics(opts.theme, need + OVERASK, avoid);
    if (candidates.length === 0) {
      log(`第 ${rounds} 轮没拿到主题，放弃补排。`);
      break;
    }

    // 填进当天还空着的整点（只看 firstSlot 往后，绝不往过去补）
    const used = await usedSlots(date);
    const free: number[] = [];
    for (let s = firstSlot; s < SLOTS_PER_DAY && free.length < need; s += 1) {
      if (!used.has(s)) free.push(s);
    }
    if (free.length === 0) {
      log("今天剩下的整点已排满，不再补排。");
      break;
    }

    const items = free.map((slot, i) => ({ slot, topic: candidates[i] })).filter((x) => x.topic);
    const n = await insertPlan(date, items);
    created += n;
    avoid.push(...items.map((i) => i.topic));
    planned = await countPlanned(date);
    log(`第 ${rounds} 轮：要 ${need} 个，模型给 ${candidates.length} 个，入库 ${n} 个（去重后）。`);
  }

  return { created, total: planned, rounds };
}
