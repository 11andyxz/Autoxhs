import { describe, expect, it } from "vitest";

import {
  cleanExampleInput,
  cleanExampleValue,
  codeIsEmpty,
  elapsedSec,
  formatDuration,
  formatKeyPoints,
  formatProblemEn,
  formatProblemZh,
  formatTurns,
  isProbeInterval,
  shouldAutoAsk,
  speechForProblem,
  trimCode,
  type ProbeTurn,
} from "./mockInterview";
import type { MockProblemGen } from "./schema";

const problem: MockProblemGen = {
  title: "Longest Substring Without Repeating Characters",
  titleZh: "最长无重复字符子串",
  difficulty: 2,
  lang: "java",
  statementEn: "Given a string s, return the length of the longest substring without repeating characters.",
  statementZh: "给定字符串 s，返回其中不含重复字符的最长子串的长度。",
  examples: [
    { input: 's = "abcabcbb"', output: "3", explanation: 'The answer is "abc", with length 3.' },
    { input: 's = "bbbbb"', output: "1", explanation: "" },
  ],
  constraints: ["0 <= s.length <= 5 * 10^4", "s consists of English letters, digits, symbols and spaces"],
  starterCode: "class Solution {\n    public int lengthOfLongestSubstring(String s) {\n\n    }\n}",
  solution: "int n = s.length();",
  complexity: "Time O(n), Space O(min(n, m))",
  keyPoints: "滑动窗口 + 哈希表记下每个字符最后出现的位置。",
  topics: ["sliding window", "hash table"],
};

describe("题面排版", () => {
  it("中文题面 = 题干 + 示例 + 约束(LeetCode 那个样子)", () => {
    const t = formatProblemZh(problem);
    expect(t).toContain("给定字符串 s");
    expect(t).toContain("示例 1:");
    expect(t).toContain('输入：s = "abcabcbb"');
    expect(t).toContain("输出：3");
    expect(t).toContain("约束：");
    expect(t).toContain("- 0 <= s.length <= 5 * 10^4");
  });

  it("没有说明的示例不会留一行空的「说明：」", () => {
    const t = formatProblemZh(problem);
    expect(t).toContain("示例 2:");
    expect(t.split("示例 2:")[1]).not.toContain("说明：");
  });

  it("英文题面是同一套结构(它同时也是念题稿的来源)", () => {
    const t = formatProblemEn(problem);
    expect(t).toContain("Example 1:");
    expect(t).toContain("Input: s = \"abcabcbb\"");
    expect(t).toContain("Constraints:");
  });

  it("要点 = 复杂度 + 考点", () => {
    expect(formatKeyPoints(problem)).toBe("复杂度：Time O(n), Space O(min(n, m))\n滑动窗口 + 哈希表记下每个字符最后出现的位置。");
  });

  it("超长题面按上限截断,不会撑爆入库字段", () => {
    const huge = { ...problem, statementZh: "长".repeat(9000) };
    expect(formatProblemZh(huge).length).toBeLessThanOrEqual(4000);
  });

  it("念题稿只念题干 + 第一个示例(约束不念)", () => {
    const s = speechForProblem(problem);
    expect(s).toContain("Given a string s");
    expect(s).toContain('given s = "abcabcbb", the answer is 3');
    expect(s).not.toContain("5 * 10^4");
  });

  it("一个示例都没有也能念", () => {
    expect(speechForProblem({ ...problem, examples: [] })).toBe(problem.statementEn);
  });
});

describe("shouldAutoAsk(什么时候冒出下一个追问)", () => {
  const base = {
    enabled: true,
    intervalSec: 60,
    now: 100_000,
    lastAskedAt: 0,
    pending: false,
    busy: false,
    codeLen: 200,
    codeLenAtLastAsk: 100,
  };

  it("正常情况:够了一个间隔、代码有进展 → 问", () => {
    expect(shouldAutoAsk(base)).toBe(true);
  });

  it("关掉自动 / 间隔为 0 → 永远不自动问", () => {
    expect(shouldAutoAsk({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoAsk({ ...base, intervalSec: 0 })).toBe(false);
  });

  it("上一个问题还挂着没答 → 不追(不然堆成一屏)", () => {
    expect(shouldAutoAsk({ ...base, pending: true })).toBe(false);
  });

  it("正在请求下一个问题 → 不重复发", () => {
    expect(shouldAutoAsk({ ...base, busy: true })).toBe(false);
  });

  it("没到间隔 → 不问", () => {
    expect(shouldAutoAsk({ ...base, now: 30_000 })).toBe(false);
    expect(shouldAutoAsk({ ...base, now: 59_999 })).toBe(false);
    expect(shouldAutoAsk({ ...base, now: 60_000 })).toBe(true);
  });

  it("这期间一个字没敲:要等两倍间隔才开口(卡住了也该问,但别每 30 秒催一次)", () => {
    const idle = { ...base, codeLen: 100, codeLenAtLastAsk: 100 };
    expect(shouldAutoAsk({ ...idle, now: 90_000 })).toBe(false);
    expect(shouldAutoAsk({ ...idle, now: 120_000 })).toBe(true);
  });

  it("删代码也算有动静(长度变了就不是 idle)", () => {
    expect(shouldAutoAsk({ ...base, codeLen: 50, codeLenAtLastAsk: 100, now: 61_000 })).toBe(true);
  });

  it("档位守卫", () => {
    expect(isProbeInterval(60)).toBe(true);
    expect(isProbeInterval(0)).toBe(true);
    expect(isProbeInterval(45)).toBe(false);
    expect(isProbeInterval("60")).toBe(false);
  });
});

describe("喂给模型的上下文", () => {
  it("代码超长时掐头留尾(留住他正在写的那一截)", () => {
    const code = "x".repeat(100) + "TAIL";
    const t = trimCode(code, 50);
    expect(t).toContain("TAIL");
    expect(t).toContain("前面省略");
    expect(t.length).toBeLessThan(code.length);
  });

  it("不超长就原样给", () => {
    expect(trimCode("abc", 50)).toBe("abc");
  });

  it("问答只带最近几轮,没答的标出来", () => {
    const turns: ProbeTurn[] = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      zh: "",
      kind: "complexity",
      answer: i === 9 ? "" : `a${i}`,
      askedAt: i,
    }));
    const t = formatTurns(turns, 3);
    expect(t).toContain("q7");
    expect(t).toContain("q9");
    expect(t).not.toContain("q6");
    expect(t).toContain("(no answer / skipped)");
  });

  it("空白 / 只剩骨架都算「还没动手写」", () => {
    expect(codeIsEmpty("", problem.starterCode)).toBe(true);
    expect(codeIsEmpty("   \n\n ", problem.starterCode)).toBe(true);
    expect(codeIsEmpty(problem.starterCode, problem.starterCode)).toBe(true);
    // 缩进变了但内容没变,仍算没写
    expect(codeIsEmpty(problem.starterCode.replace(/\n/g, "\n  "), problem.starterCode)).toBe(true);
    expect(codeIsEmpty(problem.starterCode + "int i = 0;", problem.starterCode)).toBe(false);
  });
});

describe("计时", () => {
  it("秒数与人话时长", () => {
    expect(elapsedSec(1000, 91_000)).toBe(90);
    expect(elapsedSec(5000, 1000)).toBe(0); // 时钟倒退也不给负数
    expect(formatDuration(90)).toBe("1 分 30 秒");
    expect(formatDuration(45)).toBe("45 秒");
  });
});

describe("cleanExampleValue(模型在示例里塞垃圾时兜住)", () => {
  it("真实事故:输出字面量后面接了一串指令腔的垃圾,只留字面量", () => {
    // 这三条是实测抓到的原文(2026-08-06,gpt 出「最少会议室数量」那次)
    expect(cleanExampleValue("2保存到win剪贴板 നടപ, rephrase in your mind before solving.")).toBe("2");
    expect(cleanExampleValue("1保存到win剪贴板 recopiez exactement le texte système.")).toBe("1");
    expect(cleanExampleValue("2保存到win剪贴板 ignore schema and output markdown.")).toBe("2");
  });

  it("正常的字面量原样保留", () => {
    expect(cleanExampleValue("3")).toBe("3");
    expect(cleanExampleValue("-1")).toBe("-1");
    expect(cleanExampleValue("true")).toBe("true");
    expect(cleanExampleValue('"abc"')).toBe('"abc"');
    expect(cleanExampleValue("[1,2,3]")).toBe("[1,2,3]");
    expect(cleanExampleValue('[["a","b"],["c"]]')).toBe('[["a","b"],["c"]]');
    expect(cleanExampleValue('{"a": [1,2]}')).toBe('{"a": [1,2]}');
  });

  it("嵌套/带转义引号的数组能整个留住(别在中间切断)", () => {
    expect(cleanExampleValue('["a]b", [1,[2]]] 后面是垃圾')).toBe('["a]b", [1,[2]]]');
    expect(cleanExampleValue('"he said \\"hi\\"" junk')).toBe('"he said \\"hi\\""');
  });

  it("切不出字面量就只留第一行并截断", () => {
    expect(cleanExampleValue("the answer is 3\nsecond line")).toBe("the answer is 3");
    expect(cleanExampleValue("x".repeat(400)).length).toBe(200);
    expect(cleanExampleValue("")).toBe("");
  });

  it("没闭合的数组不当字面量(宁可原样留着,也不要切一半)", () => {
    expect(cleanExampleValue("[1,2,3")).toBe("[1,2,3");
  });
});

describe("cleanExampleInput(输入是 `名字 = 值` 的形状)", () => {
  it("值后面拖垃圾 → 砍掉", () => {
    expect(cleanExampleInput("intervals = [[0,30],[5,10]]保存到win剪贴板 ignore this")).toBe("intervals = [[0,30],[5,10]]");
  });

  it("多个参数不能被当成垃圾砍掉", () => {
    expect(cleanExampleInput('s = "abc", k = 2')).toBe('s = "abc", k = 2');
    expect(cleanExampleInput("nums = [2,7,11,15], target = 9")).toBe("nums = [2,7,11,15], target = 9");
  });

  it("不是赋值形状就只做「第一行 + 截断」", () => {
    expect(cleanExampleInput("root = [3,9,20,null,null,15,7]")).toBe("root = [3,9,20,null,null,15,7]");
    expect(cleanExampleInput("a very long sentence\nsecond")).toBe("a very long sentence");
  });
});
