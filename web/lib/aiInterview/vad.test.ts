import { describe, expect, it } from "vitest";

import { DEFAULT_VAD, initVad, rmsOf, stepVad, type VadEvent, type VadState } from "./vad";

/** 按 tickMs 一步一步喂音量,返回事件序列 */
function run(levels: number[], tickMs = 80): { events: VadEvent[]; state: VadState } {
  let state = initVad();
  const events: VadEvent[] = [];
  levels.forEach((rms, i) => {
    const out = stepVad(state, rms, i * tickMs, DEFAULT_VAD);
    state = out.state;
    if (out.event) events.push(out.event);
  });
  return { events, state };
}

const rep = (value: number, times: number) => Array.from({ length: times }, () => value);

/**
 * 一段「真人语音」的音量序列:重点是**词间有下探**(0.01~0.09)。
 * 之前的测试全用恒定音量,才让「门槛被自己推高 → 起始计时永远攒不满」的真实故障溜过去。
 * 数值取自 2026-07-29 实测的一段面试官语音。
 */
const SPEECH = [0.28, 0.05, 0.15, 0.01, 0.22, 0.09, 0.33, 0.02, 0.18, 0.06];
const speech = (ticks: number) => Array.from({ length: ticks }, (_, i) => SPEECH[i % SPEECH.length]);

describe("stepVad", () => {
  it("安静 → 说话 → 安静 得到一次 start 和一次 stop", () => {
    const { events } = run([...rep(0.001, 10), ...rep(0.08, 20), ...rep(0.001, 15)]);
    expect(events).toEqual(["start", "stop"]);
  });

  it("说话中的短停顿不切段", () => {
    // 停 320ms(4 tick)< silenceMs 700ms
    const { events } = run([
      ...rep(0.001, 10),
      ...rep(0.08, 15),
      ...rep(0.001, 4),
      ...rep(0.08, 15),
      ...rep(0.001, 15),
    ]);
    expect(events).toEqual(["start", "stop"]);
  });

  it("单个尖峰不算开始说话(要连续超过 onsetMs)", () => {
    const { events } = run([...rep(0.001, 10), 0.09, ...rep(0.001, 10)]);
    expect(events).toEqual([]);
  });

  it("说太久会强制切一刀且仍在说话", () => {
    const { events, state } = run([...rep(0.001, 5), ...rep(0.08, 250)]); // 250*80ms = 20s
    expect(events[0]).toBe("start");
    expect(events).toContain("cut");
    expect(state.speaking).toBe(true);
  });

  it("环境噪声高时门槛自动抬高,不会一直误触发", () => {
    // 持续 0.02 的底噪:噪声底会收敛到 ~0.02,门槛 = 0.06,所以 0.02 不触发
    const { events } = run(rep(0.02, 200));
    expect(events).toEqual([]);
  });

  it("底噪高时更大的人声照样能触发", () => {
    const { events } = run([...rep(0.02, 100), ...rep(0.25, 20), ...rep(0.02, 15)]);
    expect(events).toEqual(["start", "stop"]);
  });

  /* ---------- 回归:2026-07-29 实测「一段结束后就再也听不见」 ---------- */

  it("一句说完、停顿后接着说 → 必须再切出第二段(曾经哑掉整整 38 秒)", () => {
    const { events } = run([
      ...rep(0.001, 15), // 热身 + 静音
      ...speech(40), // 第一句(约 3.4s)
      ...rep(0.001, 12), // 句间停顿(约 1s > silenceMs)
      ...speech(40), // 接着说第二句 —— 这一段以前会被完全吃掉
      ...rep(0.001, 15),
    ]);
    expect(events).toEqual(["start", "stop", "start", "stop"]);
  });

  it("停顿后隔十几秒的下一个问题也要听得见", () => {
    // 静音用 0.0005:实测系统音的数字静音是 0.00003,麦克风底噪 0.002~0.01,
    // 中间那种「0.001」是合成信号才有的怪值(比自适应底噪高、又比门槛低),不拿它当静音。
    const { events } = run([
      ...rep(0.0005, 15),
      ...speech(40),
      ...rep(0.0005, 200), // 中间静音十几秒(面试官在等你回答)
      ...speech(40),
      ...rep(0.0005, 15),
    ]);
    expect(events).toEqual(["start", "stop", "start", "stop"]);
  });

  it("真人语音的词间下探不打断起始判定(只有真安静才作废候选)", () => {
    // 响一帧 → 掉一帧 → 再响…累计够 onsetMs 就该开始,而不是被每次下探清零
    const jitter = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.25 : 0.004));
    const { events } = run([...rep(0.001, 15), ...jitter, ...rep(0.001, 15)]);
    expect(events).toEqual(["start", "stop"]);
  });

  /* ---------- 回归:2026-07-29 实测「Zoom 电平的语音一段都切不出来」 ---------- */

  it("很轻的音源(Zoom 经系统音,峰值只有 0.048)也要能切出段", () => {
    // 把 SPEECH 整体衰减到 6%,模拟实测的 Zoom 电平(p50 0.0016 / 峰值 0.048)。
    // absFloor 曾经是 0.006(照 Chrome 标签页音频的 0.28~0.38 调的),
    // 结果这种电平下 0 段 —— 面试官问了什么完全看不见。
    const quiet = speech(60).map((v) => v * 0.06);
    const { events } = run([...rep(0.00003, 15), ...quiet, ...rep(0.00003, 15)]);
    expect(events).toEqual(["start", "stop"]);
  });

  it("绝对下限不能高到盖住自适应底噪(不然轻音源直接哑掉)", () => {
    // 这条是给未来改参数的人看的:absFloor 只是兜底,别当主门槛
    expect(DEFAULT_VAD.absFloor).toBeLessThanOrEqual(0.002);
  });

  it("人声不参与噪声底:说完一句后门槛不该被抬高", () => {
    let state = initVad();
    const feed = (levels: number[], from: number) =>
      levels.forEach((rms, i) => {
        state = stepVad(state, rms, (from + i) * 80, DEFAULT_VAD).state;
      });
    feed([...rep(0.001, 15), ...speech(40), ...rep(0.001, 12)], 0);
    // 门槛 = 底噪×3;人声峰值 0.33 若被学进底噪,门槛会到 0.1 以上
    expect(state.noiseFloor * DEFAULT_VAD.ratio).toBeLessThan(0.02);
  });
});

describe("rmsOf", () => {
  it("全零是 0,常量帧等于该常量", () => {
    expect(rmsOf(new Float32Array(64))).toBe(0);
    expect(rmsOf(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it("空帧不炸", () => {
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });
});
