import { describe, expect, it } from "vitest";

import {
  BULK_CLUSTER_MIN,
  CRAM_BLOCK_CATEGORIES,
  CRAM_CATEGORIES,
  CRAM_CATEGORY_META,
  cramCategory,
  defaultCramSource,
  guessLegacyCramSource,
  isCramBlockCategory,
  isCramCategory,
} from "./cramCategory";

describe("cramCategory(一张卡属于哪一类)", () => {
  it("word / svg 由 kind 定死,source 写错也盖不掉", () => {
    expect(cramCategory({ kind: "word", source: "import", front: "merchant" })).toBe("word");
    expect(cramCategory({ kind: "svg", source: "ask", front: "" })).toBe("svg");
  });

  it("block 卡看 source", () => {
    expect(cramCategory({ kind: "block", source: "ask", front: "x" })).toBe("ask");
    expect(cramCategory({ kind: "block", source: "import", front: "x" })).toBe("import");
    expect(cramCategory({ kind: "block", source: "note", front: "" })).toBe("note");
    expect(cramCategory({ kind: "block", source: "coding", front: "Two Sum" })).toBe("coding");
  });

  it("source 缺失/无效时按正面形态兜底(❓=追问、有题面=题库、没题面=划词块)", () => {
    expect(cramCategory({ kind: "block", source: null, front: "Spring Batch\n\n❓ 这是用来干嘛的？" })).toBe("ask");
    expect(cramCategory({ kind: "block", source: undefined, front: "Can you talk about CI/CD?" })).toBe("import");
    expect(cramCategory({ kind: "block", source: "", front: "   " })).toBe("note");
    expect(cramCategory({ kind: "block", source: "乱写的", front: "" })).toBe("note");
    // word/svg 不是 block 能挑的分类,当作没写
    expect(cramCategory({ kind: "block", source: "word", front: "Can you talk about CI/CD?" })).toBe("import");
  });

  it("front 完全缺省(undefined)不炸", () => {
    expect(cramCategory({ kind: "block" })).toBe("note");
  });
});

describe("guessLegacyCramSource(历史卡回填)", () => {
  const base = { kind: "block", hasQuestionMark: false, hasFront: true, isCoding: false, sameSecondCount: 1 };

  it("按 kind 认单词卡和图卡(不看别的信号)", () => {
    expect(guessLegacyCramSource({ ...base, kind: "word", sameSecondCount: 99 })).toBe("word");
    expect(guessLegacyCramSource({ ...base, kind: "svg", hasFront: false })).toBe("svg");
  });

  it("extra_json 标了 coding 的优先算 Coding 题", () => {
    expect(guessLegacyCramSource({ ...base, isCoding: true })).toBe("coding");
    // 即使正面带 ❓,coding 也更可信(它是写入时明确记下的)
    expect(guessLegacyCramSource({ ...base, isCoding: true, hasQuestionMark: true })).toBe("coding");
  });

  it("正面带 ❓ = 追问存下来的卡", () => {
    expect(guessLegacyCramSource({ ...base, hasQuestionMark: true })).toBe("ask");
    // 就算它落在一个批量簇里,❓ 也说明是追问
    expect(guessLegacyCramSource({ ...base, hasQuestionMark: true, sameSecondCount: 55 })).toBe("ask");
  });

  it("没有正面 = 划词直接加入的知识块", () => {
    expect(guessLegacyCramSource({ ...base, hasFront: false })).toBe("note");
  });

  it("有正面、同一秒挤了一堆 = 批量导入的题库", () => {
    expect(guessLegacyCramSource({ ...base, sameSecondCount: BULK_CLUSTER_MIN })).toBe("import");
    expect(guessLegacyCramSource({ ...base, sameSecondCount: 55 })).toBe("import");
  });

  it("有正面、同一秒没几张 = 追问时没选原文(front 只有问题)", () => {
    expect(guessLegacyCramSource({ ...base, sameSecondCount: 1 })).toBe("ask");
    expect(guessLegacyCramSource({ ...base, sameSecondCount: BULK_CLUSTER_MIN - 1 })).toBe("ask");
  });

  it("真实库里那 360 张的分布(word153/ask71/import122/note12/svg1/coding1)能被这套规则还原", () => {
    // 用探查真库得到的形态做样本:每种形态各一条,确认落到预期分类。
    const samples: Array<[Parameters<typeof guessLegacyCramSource>[0], string]> = [
      [{ ...base, kind: "word", hasQuestionMark: false }, "word"],
      [{ ...base, kind: "svg", hasFront: false }, "svg"],
      [{ ...base, isCoding: true }, "coding"],
      // id=15「Java 17 and Spring Boot services on AWS⏎⏎❓ 你是如何 deploy them to the AWS」
      [{ ...base, hasQuestionMark: true }, "ask"],
      // id=46 只有正文的划词块
      [{ ...base, hasFront: false }, "note"],
      // 2026-07-19 04:00:10 那批 55 道 Excel 题
      [{ ...base, sameSecondCount: 55 }, "import"],
      // id=10「这个是怎么做到的？」——追问但没选原文,同一秒只有它自己
      [{ ...base, sameSecondCount: 1 }, "ask"],
    ];
    for (const [row, want] of samples) expect(guessLegacyCramSource(row)).toBe(want);
  });
});

describe("分类常量", () => {
  it("每个分类都有图标和名字", () => {
    for (const c of CRAM_CATEGORIES) {
      expect(CRAM_CATEGORY_META[c].label).toBeTruthy();
      expect(CRAM_CATEGORY_META[c].icon).toBeTruthy();
      expect(CRAM_CATEGORY_META[c].hint).toBeTruthy();
    }
    expect(Object.keys(CRAM_CATEGORY_META).sort()).toEqual([...CRAM_CATEGORIES].sort());
  });

  it("可手改的分类是全部分类的子集,且不含 word/svg", () => {
    for (const c of CRAM_BLOCK_CATEGORIES) expect(isCramCategory(c)).toBe(true);
    expect(isCramBlockCategory("word")).toBe(false);
    expect(isCramBlockCategory("svg")).toBe(false);
  });

  it("类型守卫挡得住脏输入", () => {
    expect(isCramCategory("ask")).toBe(true);
    expect(isCramCategory("nope")).toBe(false);
    expect(isCramCategory(null)).toBe(false);
    expect(isCramCategory(3)).toBe(false);
  });

  it("默认来源按 kind 兜底", () => {
    expect(defaultCramSource("word")).toBe("word");
    expect(defaultCramSource("svg")).toBe("svg");
    expect(defaultCramSource("block")).toBe("note");
  });
});
