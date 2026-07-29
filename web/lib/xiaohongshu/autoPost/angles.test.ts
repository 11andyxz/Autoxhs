import { describe, expect, it } from "vitest";

import { ANGLES, angleInstruction, angleOutlineHint, pickAngle, pickTitle } from "./angles";

describe("角度轮换", () => {
  it("同一天相邻整点不会撞同一个讲法", () => {
    for (let slot = 0; slot < 23; slot += 1) {
      expect(pickAngle("2026-07-28", slot).id).not.toBe(pickAngle("2026-07-28", slot + 1).id);
    }
  });

  it("一天 24 个整点把 8 种讲法都用到（各 3 次）", () => {
    const counts = new Map<string, number>();
    for (let slot = 0; slot < 24; slot += 1) {
      const id = pickAngle("2026-07-28", slot).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.size).toBe(ANGLES.length);
    expect([...counts.values()].every((n) => n === 24 / ANGLES.length)).toBe(true);
  });

  it("同一个钟点隔天换讲法（不会天天同一时段同一个腔调）", () => {
    expect(pickAngle("2026-07-28", 9).id).not.toBe(pickAngle("2026-07-29", 9).id);
  });

  it("同一天同一整点恒定（重试不会换风格，图文对不上）", () => {
    expect(pickAngle("2026-07-28", 15)).toEqual(pickAngle("2026-07-28", 15));
  });

  it("避坑警示只占 1/8，且是唯一还用 bold+default 黄底的", () => {
    const pitfall = ANGLES.filter((a) => a.id === "pitfall");
    expect(pitfall).toHaveLength(1);
    const yellow = ANGLES.filter((a) => a.style === "bold" && a.palette === "default");
    expect(yellow.map((a) => a.id)).toEqual(["pitfall"]);
  });

  it("视觉组合互不重复 —— 8 个角度 8 种长相", () => {
    const looks = ANGLES.map((a) => `${a.style}/${a.palette}`);
    expect(new Set(looks).size).toBe(ANGLES.length);
  });

  it("除避坑外都压住命令式警告腔", () => {
    for (const a of ANGLES) {
      const hasRule = angleInstruction(a).includes("不要");
      expect(hasRule).toBe(a.id !== "pitfall");
    }
  });

  it("每个角度各有自己的封面 badge，不会一律「避坑」", () => {
    const badges = ANGLES.map((a) => a.badge);
    expect(new Set(badges).size).toBe(ANGLES.length);
    expect(badges.filter((b) => b === "避坑")).toHaveLength(1);
  });

  it("拆卡要求里必须钉住 badge 与讲法（否则封面会自己写回警示腔）", () => {
    for (const a of ANGLES) {
      const hint = angleOutlineHint(a);
      expect(hint).toContain(a.badge);
      expect(hint).toContain(a.label);
      // 非避坑角度还要显式禁掉命令式封面标题
      expect(hint.includes("命令式警告")).toBe(a.id !== "pitfall");
    }
  });
});

describe("按角度挑标题", () => {
  const titles = [
    { text: "OPT失业期别算错", style: "避坑型" },
    { text: "90天不是从毕业算", style: "信息差型" },
    { text: "OPT失业期怎么算", style: "疑问型" },
    { text: "OPT保身份时间线", style: "干货型" },
  ];

  it("避坑角度挑避坑型标题", () => {
    const pitfall = ANGLES.find((a) => a.id === "pitfall")!;
    expect(pickTitle(titles, pitfall)).toBe("OPT失业期别算错");
  });

  it("科普角度挑疑问/信息差型，而不是第一个避坑型", () => {
    const explainer = ANGLES.find((a) => a.id === "explainer")!;
    const picked = pickTitle(titles, explainer);
    expect(picked).not.toBe("OPT失业期别算错");
    expect(["90天不是从毕业算", "OPT失业期怎么算"]).toContain(picked);
  });

  it("一个都命中不了就退回第一个", () => {
    const onlyOne = [{ text: "随便一个标题", style: "未知型" }];
    expect(pickTitle(onlyOne, ANGLES[0])).toBe("随便一个标题");
  });

  it("空数组返回空串（调用方回落到主题名）", () => {
    expect(pickTitle([], ANGLES[0])).toBe("");
  });
});
