import { describe, expect, it } from "vitest";

import { pickExcerpt, queryTerms, scoreText } from "./codeRank";

/**
 * 代码佐证的挑选逻辑。挑错文件 = 回答里贴一段无关代码,比不贴代码更糟(面试官会顺着问),
 * 所以这里钉住:停用词不参与打分、路径命中权重最高、只靠一个词刷不出高分、截取要围绕命中处。
 */

describe("queryTerms", () => {
  it("拆驼峰、去停用词、保留原标识符", () => {
    const t = queryTerms("How do you deal with exceptions in ControllerAdvice?");
    expect(t).toContain("controlleradvice");
    expect(t).toContain("controller");
    expect(t).toContain("advice");
    expect(t).toContain("exceptions");
    for (const stop of ["how", "you", "deal", "with", "the"]) expect(t).not.toContain(stop);
  });

  it("长词优先(detokenization 比 api 更有辨识度)、最多 40 个", () => {
    const t = queryTerms("api detokenization cache");
    expect(t[0]).toBe("detokenization");
    expect(queryTerms(Array.from({ length: 80 }, (_, i) => `term${i}xyz`).join(" "))).toHaveLength(40);
  });

  it("纯停用词/空串 → 空(调用方据此直接不带代码)", () => {
    expect(queryTerms("")).toEqual([]);
    expect(queryTerms("how do you use the")).toEqual([]);
  });
});

describe("scoreText", () => {
  const terms = ["detokenization", "cache"];

  it("完全不相关 → 0", () => {
    expect(scoreText(terms, "src/main/java/Foo.java", "class Foo { int a; }")).toBe(0);
  });

  it("路径命中的分数高于同样一次的正文命中", () => {
    const byPath = scoreText(terms, "detok/DetokenizationService.java", "class X {}");
    const byBody = scoreText(terms, "src/X.java", "// detokenization happens here");
    expect(byPath).toBeGreaterThan(byBody);
  });

  it("命中的不同词越多越靠前(单个词刷 30 次也压不过两个词各一次)", () => {
    const oneTermSpam = scoreText(terms, "a.java", Array(30).fill("cache").join(" "));
    const twoTerms = scoreText(terms, "b.java", "cache detokenization");
    expect(twoTerms).toBeGreaterThan(oneTermSpam);
  });

  it("长词比短词值钱(detokenization 一次 > cache 一次)", () => {
    expect(scoreText(terms, "a.java", "detokenization")).toBeGreaterThan(scoreText(terms, "b.java", "cache"));
  });

  it("测试文件不被排除,只是略低于主代码", () => {
    const main = scoreText(terms, "src/main/java/CacheReader.java", "cache");
    const test = scoreText(terms, "src/test/java/CacheReaderTest.java", "cache");
    expect(test).toBeGreaterThan(0);
    expect(main).toBeGreaterThan(test);
  });
});

describe("pickExcerpt", () => {
  it("小文件整篇给,行号从 1 开始", () => {
    const src = "line1\nline2\nline3";
    expect(pickExcerpt(src, ["line2"], 1000)).toEqual({ text: src, startLine: 1, endLine: 3 });
  });

  it("大文件围绕命中最密集处截取,且不超预算", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `int filler${i} = ${i};`);
    filler[300] = "Optional<Card> hit = nearCache.get(token); // nearCache";
    const src = filler.join("\n");
    const r = pickExcerpt(src, ["nearcache"], 500);
    expect(r.text).toContain("nearCache");
    expect(r.text.length).toBeLessThanOrEqual(500);
    expect(r.startLine).toBeLessThanOrEqual(301);
    expect(r.endLine).toBeGreaterThanOrEqual(301);
  });

  it("一个词都没命中也能给出一段(不抛错、不返回空)", () => {
    const src = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
    const r = pickExcerpt(src, ["nothinghere"], 200);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(200);
  });
});
