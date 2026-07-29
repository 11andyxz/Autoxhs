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
