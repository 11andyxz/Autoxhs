import { describe, expect, it } from "vitest";

import { frontKey } from "./frontKey";

describe("frontKey(题库导入去重键)", () => {
  it("大小写 / 首尾空白 / 换行 / 多空格 都算同一道题", () => {
    const a = frontKey("Can you talk about CI/CD?");
    expect(frontKey("  can you TALK about   CI/CD?  ")).toBe(a);
    expect(frontKey("Can you talk\nabout CI/CD?")).toBe(a);
    expect(frontKey("Can you talk about\tCI/CD?")).toBe(a);
  });

  it("不同题目不会撞键", () => {
    expect(frontKey("What is a Functional Interface?")).not.toBe(frontKey("What is a Marker Interface?"));
  });

  it("空 / 纯空白 → 空键(调用方据此跳过去重)", () => {
    expect(frontKey("")).toBe("");
    expect(frontKey("   \n  ")).toBe("");
  });

  it("超长题目按入库长度(2000)截断后比对,和库里存的一致", () => {
    const long = "x".repeat(2500);
    expect(frontKey(long)).toHaveLength(2000);
    // 库里只存前 2000 字,所以「前 2000 字相同、后面不同」的两条会被判为同一道 —— 这是有意的。
    expect(frontKey(long)).toBe(frontKey("x".repeat(2000) + " tail"));
  });
});
