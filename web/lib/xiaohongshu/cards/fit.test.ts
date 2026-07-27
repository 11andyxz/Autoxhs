import { describe, expect, it } from "vitest";

import { FIT_MIN_SCALE, FIT_STEP, browserFitScript, fitScales, pickScale } from "./fit";

describe("fitScales", () => {
  it("从 1.0 递减到下限，含两端", () => {
    const scales = fitScales();
    expect(scales[0]).toBe(1);
    expect(scales[scales.length - 1]).toBeCloseTo(FIT_MIN_SCALE, 5);
    expect(scales[1]).toBeCloseTo(1 - FIT_STEP, 5);
  });

  it("严格递减、无重复", () => {
    const scales = fitScales();
    for (let i = 1; i < scales.length; i += 1) {
      expect(scales[i]).toBeLessThan(scales[i - 1]);
    }
  });
});

describe("pickScale", () => {
  it("原尺寸就装得下时不缩", () => {
    expect(pickScale(() => true)).toEqual({ scale: 1, overflow: false });
  });

  it("选出第一个装得下的档位", () => {
    // 只有 <= 0.85 才装得下
    const result = pickScale((s) => s <= 0.85 + 1e-9);
    expect(result.overflow).toBe(false);
    expect(result.scale).toBeCloseTo(0.85, 5);
  });

  it("全部装不下时回落到下限并标记溢出——绝不截断内容", () => {
    const result = pickScale(() => false);
    expect(result.overflow).toBe(true);
    expect(result.scale).toBeCloseTo(FIT_MIN_SCALE, 5);
  });
});

describe("browserFitScript", () => {
  it("内嵌的档位表与 fitScales 一致，避免两边逻辑漂移", () => {
    expect(browserFitScript()).toContain(JSON.stringify(fitScales()));
  });

  it("跑完会置 __fitDone，供 puppeteer 等待", () => {
    expect(browserFitScript()).toContain("window.__fitDone = true");
  });
});
