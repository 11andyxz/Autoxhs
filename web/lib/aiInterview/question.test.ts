import { describe, expect, it } from "vitest";

import { detectQuestion } from "./question";
import type { Turn } from "./schema";

/** 造一段字幕:["面试官: ...", "我: ..."] 简写 */
function turns(...items: Array<[Turn["role"], string]>): Turn[] {
  return items.map(([role, text], i) => ({ role, text, at: i * 5_000 }));
}

describe("detectQuestion", () => {
  it("英文疑问句触发回答,并判成技术题", () => {
    const d = detectQuestion(turns(["interviewer", "How would you scale a Kafka consumer group?"]));
    expect(d.shouldAnswer).toBe(true);
    expect(d.kind).toBe("technical");
  });

  it("没有问号的 tell-me-about 也算提问", () => {
    const d = detectQuestion(
      turns(["interviewer", "Tell me about a time you disagreed with your tech lead"]),
    );
    expect(d.shouldAnswer).toBe(true);
    expect(d.kind).toBe("behavioral");
  });

  it("中文口语没问号也能识别", () => {
    const d = detectQuestion(turns(["interviewer", "介绍一下你在支付系统里负责的部分"]));
    expect(d.shouldAnswer).toBe(true);
  });

  it("算法题归到 coding", () => {
    const d = detectQuestion(
      turns(["interviewer", "Let's write a function that returns the k largest elements in the array"]),
    );
    expect(d.kind).toBe("coding");
    expect(d.shouldAnswer).toBe(true);
  });

  it("薪资/流程类归到 logistics", () => {
    const d = detectQuestion(turns(["interviewer", "What are your salary expectations?"]));
    expect(d.kind).toBe("logistics");
    expect(d.shouldAnswer).toBe(true);
  });

  it("寒暄和设备确认不触发", () => {
    expect(detectQuestion(turns(["interviewer", "Hey, can you hear me okay?"])).shouldAnswer).toBe(
      false,
    );
    expect(detectQuestion(turns(["interviewer", "能听到吗?"])).shouldAnswer).toBe(false);
  });

  it("附和(嗯 / got it)不触发", () => {
    const d = detectQuestion(turns(["interviewer", "Got it."]));
    expect(d.shouldAnswer).toBe(false);
    expect(d.kind).toBe("smalltalk");
  });

  it("最后说话的是我 → 不抢话", () => {
    const d = detectQuestion(
      turns(["interviewer", "Why did you leave that role?"], ["me", "Mainly because"]),
    );
    expect(d.shouldAnswer).toBe(false);
    expect(d.question).toBe("");
  });

  it("被切成两段的一句话会合起来看", () => {
    const d = detectQuestion(
      turns(
        ["interviewer", "So walk me through how you"],
        ["interviewer", "handled the migration to Kubernetes"],
      ),
    );
    expect(d.question).toContain("walk me through");
    expect(d.question).toContain("Kubernetes");
    expect(d.shouldAnswer).toBe(true);
  });

  it("短追问在有上一个问题时标成 follow-up", () => {
    const d = detectQuestion(
      turns(["interviewer", "And why not use Redis there?"]),
      "How would you scale a Kafka consumer group?",
    );
    expect(d.isFollowUp).toBe(true);
    expect(d.shouldAnswer).toBe(true);
  });

  it("同一句重复出现时仍然报告,但和上次一致(交由调用方去重)", () => {
    const q = "What's your experience with Spring Boot?";
    const d = detectQuestion(turns(["interviewer", q]), q);
    expect(d.question).toBe(q);
    expect(d.isFollowUp).toBe(false);
  });

  it("填充词会被清掉", () => {
    const d = detectQuestion(
      turns(["interviewer", "Um, so, you know, what is your biggest weakness?"]),
    );
    expect(d.question).not.toMatch(/\bum\b/i);
    expect(d.shouldAnswer).toBe(true);
  });

  it("空字幕直接返回没有问题", () => {
    expect(detectQuestion([]).shouldAnswer).toBe(false);
  });

  /* ---------- 回归:2026-07-29 实测 ---------- */

  it("转写没带问号的短追问也要触发(疑问词开头就够)", () => {
    // 实测这句被转成句号结尾、只有 8 个词,以前只有 30 分 → 不生成答案
    const d = detectQuestion(
      [{ role: "interviewer", text: "and why not just use Redis for that.", at: 0 }],
      "How do you keep a Kafka consumer idempotent?",
    );
    expect(d.shouldAnswer).toBe(true);
    expect(d.isFollowUp).toBe(true);
  });

  it("隔了很久的两句面试官发言不能粘成一个问题", () => {
    const d = detectQuestion([
      { role: "interviewer", text: "Hi Andy, thanks for making the time today.", at: 6_100 },
      {
        role: "interviewer",
        text: "How do you keep a Kafka consumer idempotent when the same event gets delivered twice?",
        at: 79_600,
      },
    ]);
    expect(d.question).not.toContain("thanks for making the time");
    expect(d.question.startsWith("How do you keep")).toBe(true);
    expect(d.shouldAnswer).toBe(true);
  });

  it("紧挨着的两段(同一句被切开)仍然要合起来看", () => {
    const d = detectQuestion([
      { role: "interviewer", text: "So walk me through how you", at: 10_000 },
      { role: "interviewer", text: "handled the migration to Kubernetes", at: 11_800 },
    ]);
    expect(d.question).toContain("walk me through");
    expect(d.question).toContain("Kubernetes");
  });
});

describe("detectQuestion · 外放(不戴耳机)场景", () => {
  const QUESTION = "How do you keep a Kafka consumer idempotent when the same event is delivered twice?";

  it("面试官的话被扬声器回灌进麦克风 → 照样要生成答案(不能被自己的回声挡住)", () => {
    const d = detectQuestion([
      { role: "interviewer", text: QUESTION, at: 10_000 },
      // 回声:同一时刻、同样内容,被录成了「我」
      { role: "me", text: "keep a Kafka consumer idempotent when the same event is delivered", at: 10_500 },
    ]);
    expect(d.shouldAnswer).toBe(true);
    expect(d.question).toContain("Kafka consumer idempotent");
  });

  it("我真的开口答了 → 让路,不抢话", () => {
    const d = detectQuestion([
      { role: "interviewer", text: QUESTION, at: 10_000 },
      { role: "me", text: "Sure, I give every event a stable business key and dedupe on it.", at: 18_000 },
    ]);
    expect(d.shouldAnswer).toBe(false);
  });

  it("「嗯 / okay」这类附和不算在答", () => {
    const d = detectQuestion([
      { role: "interviewer", text: QUESTION, at: 10_000 },
      { role: "me", text: "Okay.", at: 16_000 },
    ]);
    expect(d.shouldAnswer).toBe(true);
  });
});
