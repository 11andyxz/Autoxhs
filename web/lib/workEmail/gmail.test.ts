import { describe, expect, it } from "vitest";

import { isValidEmail } from "./gmail";

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("bm3287@nyu.edu")).toBe(true);
    expect(isValidEmail("andy@adxztech.com")).toBe(true);
    expect(isValidEmail(" andy@adxztech.com ")).toBe(true); // trimmed
  });

  it("rejects malformed / injection-y input", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a @b.com")).toBe(false);
    expect(isValidEmail("a@b.com\nBcc: x@y.com")).toBe(false);
  });

  it("rejects recipient-smuggling values that nodemailer would split/rewrite", () => {
    // 单个 @、无空白,旧正则会误判为合法,但 nodemailer 会投递到夹带的地址
    expect(isValidEmail("foo,attacker@evil.com")).toBe(false); // 逗号拆成两个收件人
    expect(isValidEmail("name<attacker@evil.com>")).toBe(false); // 尖括号取内层地址
    expect(isValidEmail("victim@corp.com,attacker@evil.com")).toBe(false);
    expect(isValidEmail('"a"@b.com')).toBe(false);
    expect(isValidEmail("a@b.com;c@d.com")).toBe(false);
  });
});
