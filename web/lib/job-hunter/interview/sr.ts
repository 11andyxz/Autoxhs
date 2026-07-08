import { createHash } from "node:crypto";

/**
 * 间隔重复（遗忘曲线）调度器：SM-2 的务实变体。
 *
 * 每道面试题就是一张「记忆卡」。作答后按 AI 评分（0~100）折算出 SM-2 的
 * quality（0~5），再据此更新 ease_factor / 间隔 / 复习次数，算出下次到期时间。
 * 卡片答得越熟，下次复习间隔越长（1 天 → 6 天 → 间隔×EF……），
 * 答砸了则打回「重新学习」（间隔归 1 天、lapses+1）。这样就沿着艾宾浩斯
 * 遗忘曲线在「快忘之前」把你拉回来复习。
 *
 * 说明：due_at 一律在 SQL 侧用 DATE_ADD(NOW(), INTERVAL ? DAY) 落库（见 repo.ts），
 * 这里只负责纯计算，不碰时区，也不直接生成时间戳。
 */

export type SrCard = {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
};

export type SrUpdate = {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
};

const MIN_EF = 1.3;
const DEFAULT_EF = 2.5;
/** 第二次答对的间隔（天）——SM-2 经典取值 */
const SECOND_INTERVAL = 6;
/** 单卡最长间隔上限（天），约一年，避免间隔无限膨胀 */
const MAX_INTERVAL = 365;

/** 把 0~100 的评分折算成 SM-2 的 quality（0~5）。<3 视为没通过。 */
export function scoreToQuality(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score >= 90) return 5;
  if (score >= 78) return 4;
  if (score >= 60) return 3; // 及格线：算通过，间隔前进
  if (score >= 40) return 2;
  if (score >= 20) return 1;
  return 0;
}

function clampEf(ef: number): number {
  if (!Number.isFinite(ef)) return DEFAULT_EF;
  return Math.max(MIN_EF, ef);
}

/**
 * 计算作答后的新调度状态。
 * @param card  当前卡片的 SM-2 参数
 * @param quality 本次作答质量 0~5（用 scoreToQuality 从评分折算）
 */
export function scheduleNext(card: SrCard, quality: number): SrUpdate {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const prevEf = clampEf(card.ease_factor || DEFAULT_EF);

  // EF 更新公式对通过/未通过都适用；未通过时 EF 也会下降但不低于 1.3。
  const nextEf = clampEf(prevEf + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (q < 3) {
    // 没通过：打回重新学习，明天再来，记一次 lapse。
    return {
      ease_factor: nextEf,
      interval_days: 1,
      repetitions: 0,
      lapses: (card.lapses || 0) + 1,
    };
  }

  const reps = (card.repetitions || 0) + 1;
  let interval: number;
  if (reps === 1) interval = 1;
  else if (reps === 2) interval = SECOND_INTERVAL;
  else interval = Math.round((card.interval_days || SECOND_INTERVAL) * nextEf);

  interval = Math.max(1, Math.min(MAX_INTERVAL, interval));

  return {
    ease_factor: nextEf,
    interval_days: interval,
    repetitions: reps,
    lapses: card.lapses || 0,
  };
}

/** 卡片记忆状态（给复习面板/题库列表打标签用） */
export type SrState = "new" | "learning" | "young" | "mastered";

/**
 * 用「是否复习过」而非 repetitions 判断新题:答砸后 SM-2 会把 repetitions 归零,
 * 若据此判定会把「刚忘掉、正在重学」的卡误当成从没练过的新题(defeats 遗忘曲线)。
 * reviewed = 该题至少作答过一次(last_reviewed_at 非空)。
 */
export function srState(card: { reviewed: boolean; interval_days: number }): SrState {
  if (!card.reviewed) return "new";
  const i = card.interval_days || 0;
  if (i < 7) return "learning";
  if (i < 21) return "young";
  return "mastered";
}

/** 把间隔天数写成中文的「下次复习」文案 */
export function nextReviewLabel(intervalDays: number): string {
  const d = Math.max(1, Math.round(intervalDays));
  if (d === 1) return "明天";
  if (d < 7) return `${d} 天后`;
  if (d < 30) {
    const w = Math.round(d / 7);
    return `${w} 周后`;
  }
  const m = Math.round(d / 30);
  return `${m} 个月后`;
}

/**
 * 简历指纹：归一化后取 SHA-256。用于把题库「绑定」到具体简历——
 * 同一份简历再次生成时命中同一题库（幂等），不同简历各自独立。
 */
export function resumeHash(resumeText: string): string {
  const normalized = resumeText
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}
