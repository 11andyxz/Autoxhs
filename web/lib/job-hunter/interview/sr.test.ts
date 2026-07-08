import { describe, expect, it } from "vitest";

import {
  nextReviewLabel,
  resumeHash,
  scheduleNext,
  scoreToQuality,
  srState,
  type SrCard,
} from "./sr";

const fresh: SrCard = { ease_factor: 2.5, interval_days: 0, repetitions: 0, lapses: 0 };

describe("scoreToQuality", () => {
  it("maps 0~100 分到 0~5,并把 <60 视作没通过(<3)", () => {
    expect(scoreToQuality(95)).toBe(5);
    expect(scoreToQuality(80)).toBe(4);
    expect(scoreToQuality(60)).toBe(3); // 及格线:通过
    expect(scoreToQuality(59)).toBe(2); // 差一分:没通过
    expect(scoreToQuality(30)).toBe(1);
    expect(scoreToQuality(0)).toBe(0);
    expect(scoreToQuality(NaN)).toBe(0);
  });
});

describe("scheduleNext — 遗忘曲线间隔递增", () => {
  it("第一次答对:间隔 1 天,repetitions=1", () => {
    const r = scheduleNext(fresh, scoreToQuality(85));
    expect(r.interval_days).toBe(1);
    expect(r.repetitions).toBe(1);
    expect(r.lapses).toBe(0);
    expect(r.ease_factor).toBeGreaterThanOrEqual(1.3);
  });

  it("连续答对:1 → 6 → 间隔×EF 递增(越来越长)", () => {
    const r1 = scheduleNext(fresh, 5);
    expect(r1.interval_days).toBe(1);
    const r2 = scheduleNext(r1, 5);
    expect(r2.interval_days).toBe(6);
    const r3 = scheduleNext(r2, 5);
    expect(r3.interval_days).toBeGreaterThan(6); // 6 * EF(>1.3)
  });

  it("答砸(quality<3):打回重学,间隔归 1 天、repetitions 归零、lapses+1", () => {
    const learned = scheduleNext(scheduleNext(fresh, 5), 5); // reps=2, interval=6
    const lapsed = scheduleNext(learned, scoreToQuality(30));
    expect(lapsed.interval_days).toBe(1);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.lapses).toBe(1);
  });

  it("EF 不会低于 1.3(反复答差也有下限)", () => {
    let card = fresh;
    for (let i = 0; i < 10; i++) card = scheduleNext(card, 0);
    expect(card.ease_factor).toBeGreaterThanOrEqual(1.3);
  });

  it("间隔有上限,不会无限膨胀", () => {
    let card: SrCard = { ease_factor: 2.5, interval_days: 300, repetitions: 8, lapses: 0 };
    card = scheduleNext(card, 5);
    expect(card.interval_days).toBeLessThanOrEqual(365);
  });
});

describe("srState", () => {
  it("按 是否复习过 / interval 归类", () => {
    expect(srState({ reviewed: false, interval_days: 0 })).toBe("new");
    expect(srState({ reviewed: true, interval_days: 1 })).toBe("learning");
    expect(srState({ reviewed: true, interval_days: 10 })).toBe("young");
    expect(srState({ reviewed: true, interval_days: 40 })).toBe("mastered");
  });
  it("答砸打回后(reps 归零但复习过)算「学习中」,不是「新题」", () => {
    // 失败卡:reviewed=true, interval=1 —— 遗忘曲线里这是正在重学,而非从没练过
    expect(srState({ reviewed: true, interval_days: 1 })).toBe("learning");
  });
});

describe("nextReviewLabel", () => {
  it("间隔天数转中文文案", () => {
    expect(nextReviewLabel(1)).toBe("明天");
    expect(nextReviewLabel(3)).toBe("3 天后");
    expect(nextReviewLabel(14)).toBe("2 周后");
    expect(nextReviewLabel(60)).toBe("2 个月后");
  });
});

describe("resumeHash", () => {
  it("同一份简历(忽略空白/大小写)命中同一指纹", () => {
    const a = resumeHash("  Jane Doe\n Software Engineer ");
    const b = resumeHash("jane doe software engineer");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("不同简历指纹不同", () => {
    expect(resumeHash("Jane Doe")).not.toBe(resumeHash("John Smith"));
  });
});
