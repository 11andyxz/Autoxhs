import { describe, expect, it } from "vitest";

import { looksLikeEcho, overlapRatio, spanOf, textSimilarity } from "./echo";
import type { Turn } from "./schema";

const T = (role: Turn["role"], text: string, at: number): Turn => ({ role, text, at });

const QUESTION =
  "Tell me about a time you disagreed with your tech lead on a technical decision.";

describe("overlapRatio / spanOf", () => {
  it("完全重叠是 1,完全不挨着是 0", () => {
    const a = { from: 0, to: 1_000 };
    expect(overlapRatio(a, { from: 0, to: 1_000 })).toBe(1);
    expect(overlapRatio(a, { from: 2_000, to: 3_000 })).toBe(0);
    expect(overlapRatio(a, { from: 500, to: 1_500 })).toBeCloseTo(0.5, 2);
  });

  it("按文本长度估时长(说得越长占的时间越久)", () => {
    const short = spanOf(T("me", "yeah", 0));
    const long = spanOf(T("me", QUESTION, 0));
    expect(long.to - long.from).toBeGreaterThan(short.to - short.from);
  });
});

describe("textSimilarity", () => {
  it("同一句话相似度为 1", () => {
    expect(textSimilarity(QUESTION, QUESTION)).toBe(1);
  });

  it("回声常常只录到半句,包含度仍然很高", () => {
    expect(textSimilarity("disagreed with your tech lead", QUESTION)).toBeGreaterThan(0.8);
  });

  it("内容不同则很低", () => {
    expect(
      textSimilarity("Sure, at Visa I owned the settlement service", QUESTION),
    ).toBeLessThan(0.3);
  });

  it("空串不炸", () => {
    expect(textSimilarity("", QUESTION)).toBe(0);
  });
});

describe("looksLikeEcho", () => {
  const interviewer = T("interviewer", QUESTION, 10_000);

  it("同一时刻、同样内容 → 判为外放回声", () => {
    const mic = T("me", "Tell me about a time you disagreed with your tech lead", 10_400);
    expect(looksLikeEcho(mic, [interviewer, mic])).toBe(true);
  });

  it("回声只录到半句也认得出", () => {
    const mic = T("me", "disagreed with your tech lead on a technical decision", 11_500);
    expect(looksLikeEcho(mic, [interviewer, mic])).toBe(true);
  });

  it("你真的在这时候插话(内容不同)不会被误杀", () => {
    const mic = T("me", "Sorry, could you repeat the last part?", 10_500);
    expect(looksLikeEcho(mic, [interviewer, mic])).toBe(false);
  });

  it("你在他说完之后回答 → 不是回声", () => {
    const mic = T("me", "At Visa I disagreed with the vault-only read for detokenization", 20_000);
    expect(looksLikeEcho(mic, [interviewer, mic])).toBe(false);
  });

  it("面试官通道里没有对应发言 → 不是回声", () => {
    const mic = T("me", "Tell me about a time you disagreed", 10_400);
    expect(looksLikeEcho(mic, [mic])).toBe(false);
  });

  it("只看「我」的句子,面试官自己的句子不判", () => {
    expect(looksLikeEcho(interviewer, [interviewer])).toBe(false);
  });

  it("中文外放回声同样能认出", () => {
    const q = T("interviewer", "介绍一下你在支付系统里负责的部分", 5_000);
    const mic = T("me", "介绍一下你在支付系统里负责的部分", 5_300);
    expect(looksLikeEcho(mic, [q, mic])).toBe(true);
  });

  it("太久以前的面试官发言不参与比对", () => {
    const old = T("interviewer", QUESTION, 0);
    const mic = T("me", QUESTION, 60_000);
    expect(looksLikeEcho(mic, [old, mic])).toBe(false);
  });
});
