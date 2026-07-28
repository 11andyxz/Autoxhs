import { describe, expect, it } from "vitest";

import { topicKey } from "./db";
import { buildSourceLines, dedupeSources, formatSourceLine } from "./sources";

const CTA = '有需要进一步咨询以及帮助的同学 可以评论"dd"';
const USCIS = {
  org: "USCIS",
  title: "Optional Practical Training Extension for STEM Students (STEM OPT)",
  url: "https://www.uscis.gov/working-in-the-united-states/students-and-exchange-visitors/optional-practical-training-extension-for-stem-students-stem-opt",
};

describe("formatSourceLine", () => {
  it("格式固定为 来源:机构 -> 官方页面标题", () => {
    expect(formatSourceLine(USCIS)).toBe(
      "来源:USCIS -> Optional Practical Training Extension for STEM Students (STEM OPT)",
    );
  });

  it("压掉多余空白，标题原样不翻译", () => {
    expect(formatSourceLine({ org: " ICE  SEVP ", title: "  Practical\n Training " })).toBe(
      "来源:ICE SEVP -> Practical Training",
    );
  });
});

describe("buildSourceLines", () => {
  it("按给定顺序产出署名行", () => {
    expect(buildSourceLines([USCIS, { org: "ICE SEVP", title: "Students and Employment" }])).toEqual([
      "来源:USCIS -> Optional Practical Training Extension for STEM Students (STEM OPT)",
      "来源:ICE SEVP -> Students and Employment",
    ]);
  });

  it("超过上限的来源被截掉（署名不喧宾夺主）", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ org: `ORG${i}`, title: `T${i}` }));
    expect(buildSourceLines(many, 3)).toHaveLength(3);
  });

  it("没有来源就是空数组", () => {
    expect(buildSourceLines([])).toEqual([]);
  });
});

describe("dedupeSources", () => {
  it("同机构同标题只留一条，缺 org/title 的丢掉", () => {
    const out = dedupeSources([
      USCIS,
      { ...USCIS, url: "https://www.uscis.gov/other" },
      { org: "", title: "无机构" },
      { org: "ICE SEVP", title: "Students and Employment" },
    ]);
    expect(out.map((s) => s.org)).toEqual(["USCIS", "ICE SEVP"]);
  });
});

describe("topicKey", () => {
  it("忽略空格与标点：同一个问题算重复", () => {
    expect(topicKey("OPT 失业期怎么算？")).toBe(topicKey("OPT失业期怎么算"));
  });

  it("忽略大小写", () => {
    expect(topicKey("stem opt 怎么申请")).toBe(topicKey("STEM OPT怎么申请"));
  });

  it("不同问题不会撞键", () => {
    expect(topicKey("OPT什么时候生效")).not.toBe(topicKey("OPT失业期怎么算"));
  });
});
