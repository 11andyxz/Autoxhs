import { describe, expect, it } from "vitest";

import { normalizeDraft, SchemaValidationError } from "./schema";

describe("normalizeDraft", () => {
  it("trims and flattens subject to a single line (header-injection safe)", () => {
    const d = normalizeDraft({ subject: "  Plan\r\nBcc: evil@x.com  ", body: "Hi\n\nBest" });
    expect(d.subject).toBe("Plan Bcc: evil@x.com");
    expect(d.subject).not.toContain("\n");
    expect(d.subject).not.toContain("\r");
  });

  it("normalizes CRLF in body to LF and trims", () => {
    const d = normalizeDraft({ subject: "s", body: "  a\r\nb\r\n  " });
    expect(d.body).toBe("a\nb");
  });

  it("throws on empty subject", () => {
    expect(() => normalizeDraft({ subject: "   ", body: "x" })).toThrow(SchemaValidationError);
  });

  it("throws on empty body", () => {
    expect(() => normalizeDraft({ subject: "x", body: "   " })).toThrow(SchemaValidationError);
  });

  it("throws (zod) on wrong shape", () => {
    expect(() => normalizeDraft({ subject: 1, body: "x" })).toThrow();
  });
});
