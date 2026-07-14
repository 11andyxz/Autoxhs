import { describe, expect, it } from "vitest";

import { formatBytes, parseTargetMb, searchBestSetting, type EncodeFn } from "./search";

// 造一个「体积随画质、随缩放面积」变化的假编码器:size ≈ base * scale^2 * (0.08 + q)。
// 这样能确定性地检验搜索逻辑,不需要真的 canvas。
function fakeEncoder(base: number): { encode: EncodeFn; calls: Array<{ scale: number; q: number }> } {
  const calls: Array<{ scale: number; q: number }> = [];
  const encode: EncodeFn = async (scale, q) => {
    calls.push({ scale, q });
    const size = Math.round(base * scale * scale * (0.08 + q));
    return { size, blob: { size } as unknown as Blob, width: Math.round(1000 * scale), height: Math.round(800 * scale) };
  };
  return { encode, calls };
}

describe("parseTargetMb", () => {
  it("解析正数(含小数)", () => {
    expect(parseTargetMb("0.5")).toBe(0.5);
    expect(parseTargetMb(" 2 ")).toBe(2);
  });
  it("非法输入返回 null", () => {
    expect(parseTargetMb("0")).toBeNull();
    expect(parseTargetMb("-1")).toBeNull();
    expect(parseTargetMb("abc")).toBeNull();
    expect(parseTargetMb("")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("B/KB/MB 分档", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MB");
  });
});

describe("searchBestSetting", () => {
  it("全分辨率下能达标时,保留 scale=1 并取不超标的最高画质", async () => {
    // base=1_000_000: scale=1 时 size≈ 1e6*(0.08+q)。目标 500KB=512000 → q≈0.432 上限。
    const { encode } = fakeEncoder(1_000_000);
    const target = 512_000;
    const res = await searchBestSetting({ targetBytes: target, encode, qualitySteps: 10 });
    expect(res.hitTarget).toBe(true);
    expect(res.scale).toBe(1); // 没有降尺寸
    expect(res.size).toBeLessThanOrEqual(target);
    // 应贴近上限画质(0.43 附近),而不是停在最低画质
    expect(res.quality).toBeGreaterThan(0.3);
  });

  it("全分辨率最低画质都超标时,会降尺寸直到达标", async () => {
    // base 很大:scale=1 时即使 q=0.05 也 = 5e6*0.13=650000 > 300KB。必须缩小。
    const { encode } = fakeEncoder(5_000_000);
    const target = 300_000;
    const res = await searchBestSetting({ targetBytes: target, encode });
    expect(res.hitTarget).toBe(true);
    expect(res.scale).toBeLessThan(1);
    expect(res.size).toBeLessThanOrEqual(target);
  });

  it("目标极小、任何档都达不到时,返回见过的最小结果并标记未达标", async () => {
    const { encode } = fakeEncoder(5_000_000);
    const target = 1_000; // 1KB,不可能
    const res = await searchBestSetting({ targetBytes: target, encode, scales: [1, 0.5, 0.2] });
    expect(res.hitTarget).toBe(false);
    // 最小结果应来自最小的缩放档 + 最低画质
    expect(res.scale).toBe(0.2);
  });

  it("原图本就很小时,取到接近最高画质", async () => {
    const { encode } = fakeEncoder(100_000); // scale=1,q=0.95 → 103000
    const target = 500_000;
    const res = await searchBestSetting({ targetBytes: target, encode, qualitySteps: 10, maxQuality: 0.95 });
    expect(res.hitTarget).toBe(true);
    expect(res.scale).toBe(1);
    expect(res.quality).toBeGreaterThan(0.9);
  });
});
