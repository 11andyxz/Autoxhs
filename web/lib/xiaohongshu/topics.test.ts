import { describe, expect, it } from "vitest";

import { formatTopic, normalizeTagName, normalizeTagNames, tagName, topicLine } from "./topics";

describe("normalizeTagName", () => {
  it("去掉前导 # 与首尾空白", () => {
    expect(normalizeTagName("  #北美求职 ")).toBe("北美求职");
    expect(normalizeTagName("##重复井号")).toBe("重复井号");
  });

  it("保留名字中间的空格——话题名要拿去做精确匹配，不能改写", () => {
    expect(normalizeTagName("#Data Science")).toBe("Data Science");
  });
});

describe("normalizeTagNames", () => {
  it("去空、忽略大小写去重，保持原顺序", () => {
    expect(normalizeTagNames(["#OPT", "  ", "#opt", "#H1B"])).toEqual(["OPT", "H1B"]);
  });

  it("HashTag 与字符串混着传也能取到名字", () => {
    const tag = { id: "1", name: "留学生", link: "https://x", type: "topic" } as const;
    expect(normalizeTagNames([tag, "#求职"])).toEqual(["留学生", "求职"]);
    expect(tagName(tag)).toBe("留学生");
  });
});

describe("desc 里的话题写法", () => {
  it("格式固定为 #name[话题]#", () => {
    expect(formatTopic("OPT")).toBe("#OPT[话题]#");
  });

  it("多个话题之间一个空格", () => {
    expect(topicLine(["#OPT", "留学生找工作"])).toBe("#OPT[话题]# #留学生找工作[话题]#");
  });
});
