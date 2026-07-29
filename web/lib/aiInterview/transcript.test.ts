import { describe, expect, it } from "vitest";

import { formatWindow, insertTurn, lastInterviewerText, toMarkdown, windowFor } from "./transcript";
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
