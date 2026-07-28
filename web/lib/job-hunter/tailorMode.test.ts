import { describe, expect, it } from "vitest";

import {
  ADAPT_POLICY,
  DEFAULT_TAILOR_MODE,
  TAILOR_MODES,
  isTailorMode,
  lightPolicy,
  tailorModeFromForm,
  tailorSpecFromForm,
  type TailorMode,
} from "./tailorMode";
import { buildSystemPrompt } from "./prompt";

const form = (entries: Record<string, string>) => ({
  get: (k: string) => entries[k] ?? null,
});
const spec = (mode: TailorMode, allowRetitle = false) => ({ mode, allowRetitle });

describe("档位定义", () => {
  it("四档由弱到强", () => {
    expect(TAILOR_MODES).toEqual(["strict", "adapt", "light", "embellish"]);
  });

  it("默认是不激进档", () => {
    expect(DEFAULT_TAILOR_MODE).toBe("adapt");
  });

  it("isTailorMode 只认这四个", () => {
    expect(isTailorMode("light")).toBe(true);
    expect(isTailorMode("LIGHT")).toBe(false);
    expect(isTailorMode("aggressive")).toBe(false);
    expect(isTailorMode(undefined)).toBe(false);
  });
});

describe("tailorModeFromForm", () => {
  it("直接读单选的 tailorMode", () => {
    expect(tailorModeFromForm(form({ tailorMode: "light" }))).toBe("light");
    expect(tailorModeFromForm(form({ tailorMode: "embellish" }))).toBe("embellish");
  });

  it("非法值不认,落回默认档", () => {
    expect(tailorModeFromForm(form({ tailorMode: "super-aggressive" }))).toBe("adapt");
  });

  it("什么都没传 → 默认档", () => {
    expect(tailorModeFromForm(form({}))).toBe("adapt");
  });

  it("兼容早期的两个布尔开关", () => {
    expect(tailorModeFromForm(form({ allowEmbellish: "true" }))).toBe("embellish");
    expect(tailorModeFromForm(form({ adaptContent: "false" }))).toBe("strict");
    expect(tailorModeFromForm(form({ adaptContent: "true" }))).toBe("adapt");
  });
});

describe("tailorSpecFromForm", () => {
  it("light + allowRetitle 才算放开职位名", () => {
    expect(tailorSpecFromForm(form({ tailorMode: "light", allowRetitle: "true" }))).toEqual({
      mode: "light",
      allowRetitle: true,
    });
  });

  it("light 但没勾 → 职位名仍锁", () => {
    expect(tailorSpecFromForm(form({ tailorMode: "light" })).allowRetitle).toBe(false);
  });

  it("allowRetitle 只在 light 档生效:别的档传了也无效", () => {
    for (const mode of ["strict", "adapt", "embellish"] as const) {
      expect(tailorSpecFromForm(form({ tailorMode: mode, allowRetitle: "true" }))).toEqual({
        mode,
        allowRetitle: false,
      });
    }
  });
});

describe("lightPolicy 的职位名条款", () => {
  it("默认锁死职位名", () => {
    const p = lightPolicy(false);
    expect(p).toContain("Job titles must stay EXACTLY as in the original resume");
    expect(p).not.toContain("Job titles MAY be adjusted");
  });

  it("放开后可以调,但同雇主/同日期/同职级、不许升职", () => {
    const p = lightPolicy(true);
    expect(p).toContain("Job titles MAY be adjusted");
    expect(p).toContain("Same seniority");
    expect(p).toContain("Never invent a promotion");
    expect(p).toContain("Engineering Manager");
  });

  it("两种情况下雇主/地点/日期都照样锁死", () => {
    for (const p of [lightPolicy(false), lightPolicy(true)]) {
      expect(p).toContain("employer / company names, work locations, employment dates");
      expect(p).toContain("no changes to dates or locations");
    }
  });
});

describe("buildSystemPrompt 各档条款", () => {
  it("adapt:锁死雇主/地点/时间,且不许凭空加", () => {
    const p = buildSystemPrompt(spec("adapt"));
    expect(p).toContain(ADAPT_POLICY);
    expect(p).toContain("Do not invent work the candidate never did");
  });

  it("light:锁死雇佣记录,但明确放开「可以补没做过的工作内容」", () => {
    const p = buildSystemPrompt(spec("light"));
    expect(p).toContain(lightPolicy(false));
    expect(p).toContain("MAY ADD work the candidate did not actually do");
  });

  it("light + 放开职位名:提示里也要求在 changeSummary 交代改了哪些职位名", () => {
    const p = buildSystemPrompt(spec("light", true));
    expect(p).toContain("Job titles MAY be adjusted");
    expect(p).toContain("which job titles you re-labelled");
  });

  it("light 不放开职位名时,不要出现改名的说法", () => {
    expect(buildSystemPrompt(spec("light"))).not.toContain("which job titles you re-labelled");
  });

  it("light 与 adapt 是两套不同条款,别串了", () => {
    expect(buildSystemPrompt(spec("light"))).not.toContain(ADAPT_POLICY);
    expect(buildSystemPrompt(spec("adapt"))).not.toContain(lightPolicy(false));
  });

  it("strict 两套政策都不带", () => {
    const p = buildSystemPrompt(spec("strict"));
    expect(p).not.toContain(ADAPT_POLICY);
    expect(p).not.toContain(lightPolicy(false));
  });

  it("embellish 是用户主动开启的最激进档", () => {
    expect(buildSystemPrompt(spec("embellish"))).toContain("EXPLICITLY ENABLED BY THE USER");
  });

  it("五种组合各不相同(四档 + light 的职位名开关)", () => {
    const all = [
      buildSystemPrompt(spec("strict")),
      buildSystemPrompt(spec("adapt")),
      buildSystemPrompt(spec("light")),
      buildSystemPrompt(spec("light", true)),
      buildSystemPrompt(spec("embellish")),
    ];
    expect(new Set(all).size).toBe(5);
  });
});
