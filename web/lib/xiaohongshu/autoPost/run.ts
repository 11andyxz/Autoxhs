/**
 * 「每小时自动发一篇」的无人值守编排（由 launchd 定时唤醒，见 scripts/autoPost.ts）。
 *
 * 一次唤醒（tick）做的事：
 *   1) 排期：当天还没排就现排 24 个主题（懒触发，见 plan.ts）；
 *   2) 清理：把更早日期没发出去的标 missed（不积压），把卡住的 publishing 放回来；
 *   3) 节流：距上一篇成功发布不足 MIN_GAP 分钟就不发；
 *   4) 领一个「到点了还没发」的整点 → 跑完整条流水线 → 发布 → 记账。
 *
 * **补跑**就是第 4 步的自然结果：关机期间那些整点的行还是 pending，
 * 开机后每轮领走一个（受节流限制）逐篇补上，补到当天 24 个为止。
 *
 * 一条流水线 = 联网查证(官方来源) → 写文案 → 联网复核事实 → 署名来源 → 拆设计卡 →
 * 渲染 → 逐张上传 → 发布（带可点击话题 + 声明原创）。
 *
 * 安全：这是**真实、不可撤销**的写操作。总开关 AUTO_POST_ENABLED 默认关；dryRun 只生成不发布。
 */

import { CTA_LINE } from "@/lib/schema";
import { rewriteCopy } from "@/lib/openai";
import { renderCards, OUTPUT_SIZE } from "@/lib/xiaohongshu/cards/render";
import { buildOutline } from "@/lib/xiaohongshu/cards/outline";
import {
  newDeckId,
  pruneDecks,
  saveCardPng,
  saveOutline,
} from "@/lib/xiaohongshu/cards/storage";
import { publishImageNote } from "@/lib/xiaohongshu/publishNote";
import { uploadImage } from "@/lib/xiaohongshu/rednote";

import {
  claimDueSlot,
  dayStats,
  expireOldSlots,
  lastPublishedAt,
  localDate,
  markSlotDone,
  markSlotFailed,
  releaseStaleClaims,
  type PlanSlot,
} from "./db";
import { ensureDailyPlan } from "./plan";
import { researchTopic, verifyBody, type ResearchResult } from "./research";
import { buildSourceLines } from "./sources";

export type Logger = (message: string) => void;

/** caption 里最多署几条来源：够撑起可信度，又不至于喧宾夺主。 */
const MAX_SOURCE_LINES = 3;

const DEFAULT_THEME =
  "美国 F-1 留学生的 OPT（Optional Practical Training）：申请与时间线、EAD 生效、失业期、换工作与雇主信息更新、STEM 24 个月延期、身份衔接与常见踩坑";
const DEFAULT_WATERMARK = "@北美熊哥聊求职";

export type AutoPostConfig = {
  enabled: boolean;
  theme: string;
  /** 一天排几篇（上限 24，一个整点一篇） */
  perDay: number;
  /** 0=公开 1=仅自己可见 */
  privacy: 0 | 1;
  original: boolean;
  /** 两篇之间至少隔多少分钟（补跑时的节流阀，防风控） */
  minGapMin: number;
  /** 一次唤醒最多发几篇 */
  maxPerTick: number;
  watermark: string;
  dryRun: boolean;
  /** 忽略「整点是否到了」，直接领最早的待发 —— 只给手动验收用 */
  ignoreSchedule: boolean;
};

function clampInt(raw: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function parseBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw == null || raw.trim() === "") return dflt;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** 从环境变量读配置（全部带安全默认值；总开关默认关）。 */
export function readAutoPostConfig(): AutoPostConfig {
  return {
    enabled: parseBool(process.env.AUTO_POST_ENABLED, false),
    theme: (process.env.AUTO_POST_THEME || "").trim() || DEFAULT_THEME,
    perDay: clampInt(process.env.AUTO_POST_PER_DAY, 1, 24, 24),
    privacy: clampInt(process.env.AUTO_POST_PRIVACY, 0, 1, 0) as 0 | 1,
    original: parseBool(process.env.AUTO_POST_ORIGINAL, true),
    minGapMin: clampInt(process.env.AUTO_POST_MIN_GAP_MIN, 0, 180, 6),
    maxPerTick: clampInt(process.env.AUTO_POST_MAX_PER_TICK, 1, 5, 1),
    watermark: (process.env.AUTO_POST_WATERMARK || "").trim() || DEFAULT_WATERMARK,
    dryRun: false,
    ignoreSchedule: false,
  };
}

export type SlotOutcome = {
  slot: number;
  topic: string;
  ok: boolean;
  title?: string;
  noteId?: string | null;
  shareLink?: string | null;
  tags?: string[];
  missingTags?: string[];
  sources?: string[];
  issues?: string[];
  cards?: number;
  error?: string;
};

export type TickResult = {
  ran: boolean;
  reason?: string;
  date: string;
  planned: number;
  published: number;
  outcomes: SlotOutcome[];
  stats?: { total: number; done: number; pending: number; failed: number };
};

/** 把查证结果拼成给改写模型的「参考资料」。 */
function buildSourceText(topic: string, research: ResearchResult): string {
  const lines = [
    `主题：${topic}`,
    "",
    "已经过官方网站核实的事实要点（只能基于这些写，不要自行补充数字或结论）：",
    ...research.facts.map((f, i) => `${i + 1}. ${f}`),
  ];
  if (research.cautions.length) {
    lines.push("", "需要提醒读者的不确定点（官方未明确 / 个案差异大）：");
    lines.push(...research.cautions.map((c) => `- ${c}`));
  }
  lines.push(
    "",
    `资料时效：${research.asOf || "近期"}`,
    "",
    "请据此写一篇小红书笔记：讲清规则、点出时间节点与踩坑代价。不要写来源署名（系统会自动加），不要写结尾引导语。",
  );
  return lines.join("\n");
}

/**
 * 跑完一个整点的完整流水线。dryRun 时前面全做（会真渲染、真上传图片），只是最后不发。
 */
export async function runOneSlot(
  slot: PlanSlot,
  cfg: AutoPostConfig,
  log: Logger,
): Promise<SlotOutcome> {
  const base: SlotOutcome = { slot: slot.slot, topic: slot.topic, ok: false };

  log(`[${slot.slot}:00] 主题「${slot.topic}」→ 联网查证官方口径…`);
  const research = await researchTopic(slot.topic, cfg.theme);
  log(
    `[${slot.slot}:00] 查到 ${research.facts.length} 条事实、${research.sources.length} 个官方来源` +
      `（${research.sources.map((s) => s.org).join("/")}）`,
  );

  log(`[${slot.slot}:00] 写文案…`);
  const draft = await rewriteCopy(buildSourceText(slot.topic, research));
  const title = draft.titles[0]?.text?.trim() || slot.topic;

  log(`[${slot.slot}:00] 联网复核事实…`);
  const verified = await verifyBody(draft.body, research, CTA_LINE);
  if (verified.issues.length) {
    for (const issue of verified.issues) log(`[${slot.slot}:00] 复核修正：${issue}`);
  }

  // 来源署名交给 buildDesc 放进「受保护的尾部」（正文之后、CTA 之前）。
  // 不要自己拼到正文末尾：caption 一超字数，署名会跟正文一起被截掉（踩过）。
  const sourceLines = buildSourceLines(research.sources, MAX_SOURCE_LINES);

  log(`[${slot.slot}:00] 拆设计卡…`);
  const outline = await buildOutline({
    title,
    // 卡片用不带署名的正文（署名进 caption 就够了，不必占一张卡）
    body: verified.body,
    tags: draft.tags,
    style: "auto",
    palette: "auto",
    cardCount: "auto",
    watermark: cfg.watermark,
  });

  const deckId = newDeckId();
  await saveOutline(deckId, outline);
  log(`[${slot.slot}:00] 渲染 ${outline.cards.length} 张…`);
  const rendered = await renderCards(outline);
  for (const card of rendered) await saveCardPng(deckId, card.index, card.png);
  const overflow = rendered.filter((c) => c.overflow).map((c) => c.index + 1);
  if (overflow.length) log(`[${slot.slot}:00] 第 ${overflow.join("、")} 张已缩到最小字号`);

  // rednote 服务全局串行，逐张传
  const fileIds: string[] = [];
  for (const card of rendered) {
    fileIds.push(await uploadImage(card.png, "image/png"));
  }
  log(`[${slot.slot}:00] 已上传 ${fileIds.length} 张`);

  const result = await publishImageNote({
    title,
    body: verified.body,
    tags: draft.tags,
    fileIds,
    width: OUTPUT_SIZE.width,
    height: OUTPUT_SIZE.height,
    privacy: cfg.privacy,
    original: cfg.original,
    confirm: !cfg.dryRun,
    ctaLine: CTA_LINE,
    sourceLines,
  });
  if (sourceLines.length && !result.desc.keptSources) {
    log(`[${slot.slot}:00] ⚠️ caption 额度不够，来源署名没写进去（正文 ${result.desc.length}/${result.desc.limit} 字）`);
  }

  await pruneDecks();

  return {
    ...base,
    ok: true,
    title,
    noteId: result.noteId,
    shareLink: result.shareLink,
    tags: result.tags,
    missingTags: result.missingTags,
    sources: sourceLines,
    issues: verified.issues,
    cards: fileIds.length,
  };
}

/**
 * 发布成功之后的记账：重试几次再放弃。
 *
 * 这一步失败很危险 —— 行还停在 publishing，30 分钟后被 releaseStaleClaims 收走。
 * 所以那边只会把它标成 **missed 而不是可重试**：宁可漏一篇，也不要因为「不知道发没发」而发第二遍。
 */
async function recordDone(slot: PlanSlot, outcome: SlotOutcome, log: Logger): Promise<void> {
  const payload = {
    noteId: outcome.noteId,
    shareLink: outcome.shareLink,
    title: outcome.title,
    sources: (outcome.sources ?? []).join("\n"),
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await markSlotDone(slot.id, payload);
      return;
    } catch (e) {
      log(`[${slot.slot}:00] 记账第 ${attempt} 次失败：${(e as Error)?.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  log(
    `[${slot.slot}:00] ⚠️ 笔记已发布（${outcome.noteId ?? "?"}）但没能写回数据库。` +
      `请手动把 xhs_auto_post id=${slot.id} 改成 done，避免它被当成未发。`,
  );
}

/**
 * 一次唤醒。默认最多发 1 篇 —— 错过的整点靠「下一次唤醒再领一个」慢慢补，
 * 而不是一口气把积压全推出去（那是最容易触发风控的做法）。
 */
export async function runAutoPostTick(cfg: AutoPostConfig, log: Logger): Promise<TickResult> {
  const now = new Date();
  const date = localDate(now);

  if (!cfg.enabled && !cfg.dryRun) {
    return { ran: false, reason: "AUTO_POST_ENABLED 未开启", date, planned: 0, published: 0, outcomes: [] };
  }

  const released = await releaseStaleClaims();
  if (released) {
    log(`收掉 ${released} 个卡在 publishing 的排期（上一轮中断，结果未知 → 标 missed 不重试）。`);
  }
  const expired = await expireOldSlots(date);
  if (expired) log(`把 ${expired} 个更早日期未发的排期标为 missed（不积压到今天）。`);

  // fromSlot = 当前小时：中途才排今天的期时，只排「现在往后」的整点，
  // 不给自己造出一堆一落库就过期的排期（那会变成连珠炮补发）。
  const plan = await ensureDailyPlan(date, {
    theme: cfg.theme,
    count: cfg.perDay,
    fromSlot: now.getHours(),
    log,
  });
  if (plan.created) log(`今天新排了 ${plan.created} 个主题（共 ${plan.total} 个）。`);

  const outcomes: SlotOutcome[] = [];
  let published = 0;

  for (let i = 0; i < cfg.maxPerTick; i += 1) {
    // 节流：跟上一篇成功发布至少隔 minGapMin 分钟
    const last = await lastPublishedAt();
    if (last && cfg.minGapMin > 0 && !cfg.dryRun) {
      const waitedMin = (Date.now() - last) / 60000;
      if (waitedMin < cfg.minGapMin) {
        log(`距上一篇仅 ${waitedMin.toFixed(1)} 分钟（<${cfg.minGapMin}），本轮不发。`);
        break;
      }
    }

    // 只领「整点已到」的；ignoreSchedule 时不看钟（手动验收用）
    const maxSlot = cfg.ignoreSchedule ? 23 : now.getHours();
    const slot = await claimDueSlot(date, maxSlot);
    if (!slot) {
      log(published === 0 ? "没有到点待发的排期，本轮空跑。" : "没有更多到点待发的排期。");
      break;
    }

    try {
      const outcome = await runOneSlot(slot, cfg, log);
      outcomes.push(outcome);
      if (cfg.dryRun) {
        // 干跑不写状态，排期原样留着，正式跑时照常发
        await markSlotFailed(slot.id, "dry-run（未发布，状态已退回）");
        log(`[${slot.slot}:00] 干跑完成，未发布。`);
      } else {
        published += 1;
        log(`[${slot.slot}:00] ✅ 已发布 ${outcome.noteId ?? ""} ${outcome.shareLink ?? ""}`);
        // 已经发出去了 —— 记账失败也绝不能把这一轮判成失败（否则会被重新领走、重复发一篇）。
        // 多试几次；实在写不进去就大声报出来，人工把这一行标 done。
        await recordDone(slot, outcome, log);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      outcomes.push({ slot: slot.slot, topic: slot.topic, ok: false, error: msg });
      log(`[${slot.slot}:00] ❌ 失败：${msg}`);
      // 记失败本身也可能失败（比如 DB 连不上，而它正是刚才失败的原因）。
      // 那就交给 releaseStaleClaims 兜底，别让「记账出错」把整个进程炸掉。
      try {
        await markSlotFailed(slot.id, msg);
      } catch (e2) {
        log(`[${slot.slot}:00] 连失败状态都没写进 DB：${(e2 as Error)?.message}`);
      }
      // 这一轮到此为止：连着重试很可能同样失败（rednote 掉线/额度问题），交给下一次唤醒
      break;
    }
  }

  return {
    ran: true,
    date,
    planned: plan.total,
    published,
    outcomes,
    stats: await dayStats(date),
  };
}
