import { describe, expect, it } from "vitest";

import {
  allEmailsOf,
  dedupeEmails,
  formatEmailList,
  MAX_EXTRA_EMAILS,
  parseEmailList,
  trimEmployee,
  validateEmployee,
  type EmployeeInput,
} from "./validate";

const base: EmployeeInput = {
  legalFirstName: "Bin",
  legalLastName: "Meng",
  email: "bm3287@nyu.edu",
  address: "235 Grand St, Jersey City, NJ 07302",
  phone: "347-247-1749",
};

describe("parseEmailList", () => {
  it("splits on commas / semicolons / newlines / spaces", () => {
    expect(parseEmailList("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseEmailList("a@x.com;b@y.com\nc@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });
  it("drops empties", () => {
    expect(parseEmailList("")).toEqual([]);
    expect(parseEmailList("  ,  ")).toEqual([]);
  });
});

describe("dedupeEmails / allEmailsOf", () => {
  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(dedupeEmails(["A@x.com", "a@X.com", "b@y.com"])).toEqual(["A@x.com", "b@y.com"]);
  });
  it("puts the primary email first and drops a duplicate extra", () => {
    expect(allEmailsOf({ email: "a@x.com", extraEmails: ["b@y.com", "A@X.com"] })).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });
  it("tolerates a missing extras list", () => {
    expect(allEmailsOf({ email: "a@x.com" })).toEqual(["a@x.com"]);
  });
});

describe("formatEmailList", () => {
  it("joins with ', ' and drops blanks", () => {
    expect(formatEmailList(["a@x.com", " ", "b@y.com"])).toBe("a@x.com, b@y.com");
    expect(formatEmailList([])).toBe("");
  });
});

describe("validateEmployee extra emails", () => {
  it("accepts a record with no extras", () => {
    expect(validateEmployee(base)).toEqual([]);
    expect(validateEmployee({ ...base, extraEmails: [] })).toEqual([]);
  });
  it("accepts valid extras and ignores blank rows", () => {
    expect(validateEmployee({ ...base, extraEmails: ["work@adxztech.com", "  "] })).toEqual([]);
  });
  it("rejects a malformed extra email", () => {
    const errs = validateEmployee({ ...base, extraEmails: ["not-an-email"] });
    expect(errs.some((e) => e.includes("not-an-email"))).toBe(true);
  });
  it("rejects an extra that duplicates the primary (case-insensitively)", () => {
    const errs = validateEmployee({ ...base, extraEmails: ["BM3287@NYU.EDU"] });
    expect(errs.some((e) => e.includes("重复"))).toBe(true);
  });
  it("rejects duplicates among the extras themselves", () => {
    const errs = validateEmployee({ ...base, extraEmails: ["a@x.com", "a@x.com"] });
    expect(errs.some((e) => e.includes("重复"))).toBe(true);
  });
  it("caps how many extras are allowed", () => {
    const many = Array.from({ length: MAX_EXTRA_EMAILS + 1 }, (_, i) => `a${i}@x.com`);
    const errs = validateEmployee({ ...base, extraEmails: many });
    expect(errs.some((e) => e.includes("最多"))).toBe(true);
  });
});

describe("trimEmployee", () => {
  it("trims extras and drops empty rows", () => {
    const out = trimEmployee({ ...base, extraEmails: [" a@x.com ", "", "   "] });
    expect(out.extraEmails).toEqual(["a@x.com"]);
  });
});
