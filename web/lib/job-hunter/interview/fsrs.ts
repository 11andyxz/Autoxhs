import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";

/**
 * 遗忘曲线调度器 —— 用开源的 FSRS(Free Spaced Repetition Scheduler, ts-fsrs)。
 * 比 SM-2 更准:DSR 模型(难度 Difficulty / 稳定性 Stability / 可提取性 Retrievability),
 * 按「目标记忆保持率」request_retention(0.9)排下次复习。Anki 已把 FSRS 设为推荐调度器。
 *
 * 关键取舍:关掉 short-term learning steps(enable_short_term=false)——面试猛攻是「按天复习」
 * 的场景,不需要「10 分钟后再来一次」的分钟级学习步;这样每次复习都排到「N 天后」,
 * 和原来 SM-2 的日级节奏一致,只是间隔更聪明(实测 New→清楚 = +3 天,之后 3→14→57→196 天…)。
 *
 * due_at 仍在 SQL 侧用 DATE_ADD(NOW(), INTERVAL ? DAY) 落库(关掉短期步后间隔都是整天),
 * 不碰时区;距上次复习的天数由调用方用 SQL TIMESTAMPDIFF 传进来(elapsedSec),同样避开时区。
 */

const scheduler = fsrs(
  generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9 }),
);

/** 自评三档 → FSRS Rating。不记得=Again(打回重学);似乎记得=Hard;清楚=Good。 */
export type RecallGrade = "forgot" | "vague" | "clear";
export function ratingFromGrade(g: RecallGrade): Grade {
  if (g === "forgot") return Rating.Again;
  if (g === "vague") return Rating.Hard;
  return Rating.Good;
}

/** 卡片当前的 FSRS 状态(从库里读出)。elapsedSec = 距上次复习的秒数(SQL TIMESTAMPDIFF);null=新卡。 */
export type FsrsPrev = {
  difficulty: number;
  stability: number;
  state: number;
  reps: number;
  lapses: number;
  elapsedSec: number | null;
};

/** 复习后要落库的新状态。intervalDays 用于 due_at = DATE_ADD(NOW(), INTERVAL ? DAY)。 */
export type FsrsUpdate = {
  difficulty: number;
  stability: number;
  state: number;
  reps: number;
  lapses: number;
  intervalDays: number;
};

function toCard(prev: FsrsPrev, now: Date): Card {
  const base = createEmptyCard(now);
  // 新卡(从没复习过 / 无稳定性):用空卡,FSRS 会据本次评分初始化。
  if (prev.elapsedSec == null || !(prev.stability > 0)) return base;
  const lastReview = new Date(now.getTime() - Math.max(0, prev.elapsedSec) * 1000);
  return {
    ...base,
    stability: prev.stability,
    difficulty: prev.difficulty,
    reps: prev.reps,
    lapses: prev.lapses,
    state: (prev.state as State) || State.Review,
    last_review: lastReview,
  };
}

/** 复习一张卡:据当前 FSRS 状态 + 自评,算出新状态 + 下次间隔(天)。 */
export function reviewFsrs(prev: FsrsPrev, grade: RecallGrade, now: Date = new Date()): FsrsUpdate {
  const card = toCard(prev, now);
  const next = scheduler.next(card, now, ratingFromGrade(grade)).card;
  const rawDays = next.scheduled_days || (new Date(next.due).getTime() - now.getTime()) / 86400000;
  const intervalDays = Math.max(1, Math.min(3650, Math.round(rawDays)));
  return {
    difficulty: next.difficulty,
    stability: next.stability,
    state: next.state,
    reps: next.reps,
    lapses: next.lapses,
    intervalDays,
  };
}

/** 记忆状态标签(给列表/复习面板)。按 FSRS 稳定性天数分档。 */
export type SrState = "new" | "learning" | "young" | "mastered";
export function srStateFromStability(reviewed: boolean, stability: number): SrState {
  if (!reviewed) return "new";
  const s = stability || 0;
  if (s < 7) return "learning";
  if (s < 21) return "young";
  return "mastered";
}

/** 下次复习的中文文案 */
export function nextReviewLabel(intervalDays: number): string {
  const d = Math.max(1, Math.round(intervalDays));
  if (d === 1) return "明天";
  if (d < 7) return `${d} 天后`;
  if (d < 30) return `${Math.round(d / 7)} 周后`;
  if (d < 365) return `${Math.round(d / 30)} 个月后`;
  return `${Math.round(d / 365)} 年后`;
}
