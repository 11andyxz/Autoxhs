import { describe, expect, it } from "vitest";

import {
  PcmRing,
  TRANSCRIBE_RATE,
  bytesToInt16,
  downsampleForTranscribe,
  encodeWav,
  rmsOfInt16,
} from "./pcm";

describe("bytesToInt16", () => {
  it("按小端解出有符号样本", () => {
    // 0x0100 = 256, 0xFFFF = -1
    const { samples, leftover } = bytesToInt16(new Uint8Array([0x00, 0x01, 0xff, 0xff]));
    expect(Array.from(samples)).toEqual([256, -1]);
    expect(leftover.length).toBe(0);
  });

  it("奇数字节时留最后一个给下一批(不然会把样本切错位)", () => {
    const { samples, leftover } = bytesToInt16(new Uint8Array([0x00, 0x01, 0x7f]));
    expect(Array.from(samples)).toEqual([256]);
    expect(Array.from(leftover)).toEqual([0x7f]);
  });
});

describe("rmsOfInt16", () => {
  it("满幅方波接近 1,静音是 0", () => {
    expect(rmsOfInt16(new Int16Array(64).fill(32_767))).toBeCloseTo(1, 3);
    expect(rmsOfInt16(new Int16Array(64))).toBe(0);
  });
  it("空区间不炸", () => {
    expect(rmsOfInt16(new Int16Array(0))).toBe(0);
    expect(rmsOfInt16(new Int16Array(10), 5, 5)).toBe(0);
  });
});

describe("PcmRing", () => {
  it("按绝对样本号取回写进去的内容", () => {
    const ring = new PcmRing(100);
    ring.write(new Int16Array([1, 2, 3, 4, 5]));
    expect(Array.from(ring.slice(0, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(ring.end).toBe(5);
    expect(ring.start).toBe(0);
  });

  it("绕圈后仍能取到最近的样本", () => {
    const ring = new PcmRing(8);
    for (let i = 1; i <= 12; i += 1) ring.write(new Int16Array([i]));
    expect(ring.end).toBe(12);
    expect(ring.start).toBe(4);
    expect(Array.from(ring.slice(4, 12))).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("跨圈的一次大写入按最后 capacity 个保留", () => {
    const ring = new PcmRing(4);
    ring.write(new Int16Array([1, 2, 3, 4, 5, 6]));
    expect(Array.from(ring.slice(2, 6))).toEqual([3, 4, 5, 6]);
  });

  it("取超出保留范围的区间会自动裁剪,不返回垃圾", () => {
    const ring = new PcmRing(4);
    ring.write(new Int16Array([1, 2, 3, 4, 5, 6]));
    expect(Array.from(ring.slice(0, 6))).toEqual([3, 4, 5, 6]); // 前两个已被覆盖
    expect(ring.slice(10, 20).length).toBe(0);
  });

  it("写入跨越缓冲边界时数据不错位", () => {
    const ring = new PcmRing(6);
    ring.write(new Int16Array([1, 2, 3, 4]));
    ring.write(new Int16Array([5, 6, 7, 8])); // 后两个绕回开头
    expect(Array.from(ring.slice(2, 8))).toEqual([3, 4, 5, 6, 7, 8]);
  });
});

describe("encodeWav", () => {
  it("头部是合法的 16-bit 单声道 WAV", () => {
    const wav = encodeWav(new Int16Array([0, 100, -100]), 48_000);
    const text = (from: number, len: number) =>
      String.fromCharCode(...Array.from(wav.subarray(from, from + len)));
    const view = new DataView(wav.buffer);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16); // 位深
    expect(view.getUint32(40, true)).toBe(6); // 3 个样本 = 6 字节
    expect(wav.length).toBe(44 + 6);
    expect(view.getInt16(44 + 2, true)).toBe(100);
    expect(view.getInt16(44 + 4, true)).toBe(-100);
  });
});

describe("downsampleForTranscribe", () => {
  it("48k → 16k:样本数变三分之一,采样率跟着改", () => {
    const src = new Int16Array(48_000).fill(1_000);
    const out = downsampleForTranscribe(src, 48_000);
    expect(out.rate).toBe(TRANSCRIBE_RATE);
    expect(out.samples.length).toBe(16_000);
    expect(out.samples[0]).toBe(1_000); // 等值信号降采样后不变
  });

  it("每 3 个取平均(粗糙低通),不是直接抽点", () => {
    const out = downsampleForTranscribe(new Int16Array([0, 300, 600, 0, 0, 0]), 48_000);
    expect(Array.from(out.samples)).toEqual([300, 0]);
  });

  it("已经是 16k 或不是整数倍时原样返回", () => {
    const src = new Int16Array([1, 2, 3]);
    expect(downsampleForTranscribe(src, 16_000).samples.length).toBe(3);
    expect(downsampleForTranscribe(src, 44_100).rate).toBe(44_100);
  });

  it("音量在降采样后基本不变(转写质量不受影响的前提)", () => {
    const src = new Int16Array(4_800);
    for (let i = 0; i < src.length; i += 1) src[i] = Math.round(8_000 * Math.sin((2 * Math.PI * 200 * i) / 48_000));
    const out = downsampleForTranscribe(src, 48_000);
    expect(rmsOfInt16(out.samples)).toBeCloseTo(rmsOfInt16(src), 2);
  });
});
