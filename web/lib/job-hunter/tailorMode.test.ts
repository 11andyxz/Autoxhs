import { describe, expect, it } from "vitest";

import { ADAPT_POLICY, resolveTailorMode, tailorModeFromForm } from "./tailorMode";
import { buildSystemPrompt } from "./prompt";

describe("resolveTailorMode", () => {
  it("默认档是 adapt(不激进匹配默认开启)", () => {
    expect(resolveTailorMode(false, true)).toBe("adapt");
  });

  it("激进匹配优先,盖掉不激进档", () => {
    expect(resolveTailorMode(true, true)).toBe("embellish");
    expect(resolveTailorMode(true, false)).toBe("embellish");
  });

  it("两个都关 → 只重排不改内容", () => {
    expect(resolveTailorMode(false, false)).toBe("strict");
  });
});

describe("tailorModeFromForm", () => {
  const form = (entries: Record<string, string>) => ({
    get: (k: string) => entries[k] ?? null,
  });

  it("表单没带 adaptContent 时按默认(开启)处理", () => {
    expect(tailorModeFromForm(form({}))).toBe("adapt");
  });

  it("显式关闭 → strict", () => {
    expect(tailorModeFromForm(form({ adaptContent: "false" }))).toBe("strict");
  });

  it("allowEmbellish=true → embellish", () => {
    expect(tailorModeFromForm(form({ allowEmbellish: "true", adaptContent: "true" }))).toBe(
      "embellish",
    );
  });
});

describe("buildSystemPrompt", () => {
  it("adapt 档带上「锁死雇主/地点/时间」的政策", () => {
    const p = buildSystemPrompt("adapt");
    expect(p).toContain(ADAPT_POLICY);
    expect(p).toContain("employment dates");
  });

  it("strict 档不带 adapt 政策", () => {
    expect(buildSystemPrompt("strict")).not.toContain(ADAPT_POLICY);
  });

  it("embellish 档明确是用户主动开启的", () => {
    expect(buildSystemPrompt("embellish")).toContain("EXPLICITLY ENABLED BY THE USER");
  });
});
