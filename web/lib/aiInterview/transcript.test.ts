import { describe, expect, it } from "vitest";

import {
  echoesPrompt,
  formatWindow,
  insertTurn,
  lastInterviewerText,
  looksLikeHallucination,
  toMarkdown,
  windowFor,
} from "./transcript";
import type { Turn } from "./schema";

const T = (role: Turn["role"], text: string, at: number): Turn => ({ role, text, at });

describe("insertTurn", () => {
  it("同一角色紧接着的两段合成一句", () => {
    const out = insertTurn([T("interviewer", "So walk me through", 1_000)], {
      role: "interviewer",
      text: "the migration",
      at: 2_200,
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("So walk me through the migration");
  });

  it("中文合并不插空格", () => {
    const out = insertTurn([T("interviewer", "介绍一下", 0)], {
      role: "interviewer",
      text: "你的项目",
      at: 800,
    });
    expect(out[0].text).toBe("介绍一下你的项目");
  });

  it("换人说话不合并", () => {
    const out = insertTurn([T("interviewer", "Why?", 1_000)], {
      role: "me",
      text: "Because",
      at: 1_500,
    });
    expect(out).toHaveLength(2);
  });

  it("乱序回来的转写按时间插到正确位置", () => {
    let list: Turn[] = [T("interviewer", "第一句", 1_000)];
    list = insertTurn(list, T("me", "第三句", 30_000));
    list = insertTurn(list, T("me", "第二句", 10_000));
    expect(list.map((t) => t.text)).toEqual(["第一句", "第二句", "第三句"]);
  });

  it("空文本被丢掉,原数组不变", () => {
    const list = [T("me", "x", 0)];
    expect(insertTurn(list, T("me", "   ", 100))).toBe(list);
  });
});

describe("windowFor / formatWindow", () => {
  it("只取最近 N 秒", () => {
    const list = [
      T("interviewer", "很久以前", 0),
      T("interviewer", "刚刚", 400_000),
      T("me", "现在", 420_000),
    ];
    const win = windowFor(list, 420_000, 60);
    expect(win.map((t) => t.text)).toEqual(["刚刚", "现在"]);
  });

  it("窗口内没有内容时退回给最后几句(别把上下文清空)", () => {
    const list = [T("interviewer", "很久以前", 0)];
    expect(windowFor(list, 999_999, 10)).toHaveLength(1);
  });

  it("超字数上限时保留最近的", () => {
    const list = [
      T("interviewer", "a".repeat(200), 0),
      T("interviewer", "b".repeat(200), 1_000),
    ];
    const text = formatWindow(list, 230);
    expect(text).toContain("b".repeat(200));
    expect(text).not.toContain("a".repeat(200));
  });

  it("角色带标签,建议答案标成 suggested-answer", () => {
    const text = formatWindow([T("assistant", "说这个", 0)]);
    expect(text).toBe("[suggested-answer] 说这个");
  });
});

describe("lastInterviewerText", () => {
  it("取最后一句面试官的话", () => {
    expect(
      lastInterviewerText([T("interviewer", "A", 0), T("me", "B", 1), T("interviewer", "C", 2)]),
    ).toBe("C");
  });
  it("没有面试官说话时返回空串", () => {
    expect(lastInterviewerText([T("me", "B", 1)])).toBe("");
  });
});

describe("looksLikeHallucination", () => {
  it("认出安静片段上的字幕垃圾", () => {
    // 实测麦克风通道在没人说话时反复吐这条
    expect(looksLikeHallucination("https://www.linkedin.com.au")).toBe(true);
    expect(looksLikeHallucination("www.github.com")).toBe(true);
    expect(looksLikeHallucination("Thanks for watching!")).toBe(true);
    expect(looksLikeHallucination("Please subscribe")).toBe(true);
    expect(looksLikeHallucination("字幕由 Amara.org 社区提供")).toBe(true);
    expect(looksLikeHallucination("感谢观看")).toBe(true);
  });

  it("认出噪声上的重复刷屏(真实面试里录到过整屏「無缺無缺…」)", () => {
    expect(looksLikeHallucination("無垢無缺無缺無缺無缺無缺無缺無缺無缺無缺無缺無缺")).toBe(true);
    expect(looksLikeHallucination("哈哈哈哈哈哈哈哈哈哈哈哈哈哈")).toBe(true);
  });

  it("只有标点/点点点的当没听到", () => {
    expect(looksLikeHallucination(". . . . . . .")).toBe(true);
    expect(looksLikeHallucination("——…")).toBe(true);
  });

  it("设了英文却吐出成片中日韩字符 → 判为幻觉", () => {
    expect(looksLikeHallucination("無垢無缺 これは", "en")).toBe(true);
    // 中文场次不适用这条(中文答案里夹英文术语很正常)
    expect(looksLikeHallucination("介绍一下你的项目", "zh")).toBe(false);
  });

  it("不误伤正常回答(哪怕里面提到网址或订阅)", () => {
    expect(
      looksLikeHallucination("We push metrics to https://grafana.internal and alert on p99."),
    ).toBe(false);
    expect(looksLikeHallucination("I built the subscribe flow for the billing service.")).toBe(false);
    expect(looksLikeHallucination("Tell me about yourself")).toBe(false);
    expect(looksLikeHallucination("")).toBe(false);
    // 英文场次里正常的英文句子不能被 CJK 规则误杀
    expect(
      looksLikeHallucination("Can you explain how the Java memory model guarantees visibility?", "en"),
    ).toBe(false);
    // 英文场次里夹一两个中文词也不算(比例不够)
    expect(looksLikeHallucination("We call it 灰度 release in our team", "en")).toBe(false);
  });
});

describe("echoesPrompt", () => {
  const hint = "Kafka, Kubernetes, Spring Boot, JVM, volatile, ConcurrentHashMap, Visa, Stripe";

  it("识别出「把提示词原样吐回来」(实测 gpt-4o-mini-transcribe 在静音上每次都这样)", () => {
    expect(echoesPrompt("Kafka, Kubernetes, Spring Boot, JVM, volatile, ConcurrentHashMap", hint)).toBe(true);
    expect(echoesPrompt("volatile", hint)).toBe(true);
    expect(echoesPrompt("Stripe Visa Kafka", hint)).toBe(true);
  });

  it("正常问题里出现这些术语不算回声(有动词/冠词等提示词外的词)", () => {
    expect(
      echoesPrompt("How do you keep a Kafka consumer idempotent when the same event is delivered twice?", hint),
    ).toBe(false);
    expect(echoesPrompt("Tell me about your Kubernetes migration at Visa.", hint)).toBe(false);
  });

  it("没有提示词 / 空文本时不判", () => {
    expect(echoesPrompt("Kafka", "")).toBe(false);
    expect(echoesPrompt("", hint)).toBe(false);
  });
});

describe("toMarkdown", () => {
  it("带上标题、总结与逐句时间戳", () => {
    const md = toMarkdown({
      title: "Amazon 面试",
      company: "Amazon",
      mode: "技术面试",
      startedAt: "2026-07-29 10:00",
      summary: "整体不错",
      turns: [T("interviewer", "Tell me about yourself", 65_000)],
    });
    expect(md).toContain("# Amazon 面试");
    expect(md).toContain("## 复盘总结");
    expect(md).toContain("整体不错");
    expect(md).toContain("[01:05] 面试官:** Tell me about yourself");
  });

  it("没有总结时不留空的总结小节", () => {
    const md = toMarkdown({
      title: "t",
      company: "",
      mode: "技术面试",
      startedAt: "now",
      turns: [],
    });
    expect(md).not.toContain("## 复盘总结");
  });
});
