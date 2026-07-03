import { describe, expect, it } from "vitest";

import { cosine, normalizeQuestionText, resolveValue } from "./kb";

describe("normalizeQuestionText", () => {
  it("strips html, punctuation, case and extra whitespace", () => {
    expect(normalizeQuestionText("<b>How many</b> years of  React?!")).toBe(
      "how many years of react",
    );
  });
  it("treats differently-formatted equivalents as equal", () => {
    expect(normalizeQuestionText("Do you have a valid driver's license?")).toBe(
      normalizeQuestionText("do you have a valid drivers license"),
    );
  });
});

describe("resolveValue", () => {
  const yesNo = {
    options: [
      { value: "YES", label: "Yes" },
      { value: "NO", label: "No" },
    ],
  };

  it("free-text question: uses stored value verbatim", () => {
    expect(resolveValue({ options: null }, { answer_value: "5 years", answer_label: null })).toEqual({
      value: "5 years",
      valueLabel: null,
    });
  });

  it("option question: maps by value when value still valid", () => {
    expect(resolveValue(yesNo, { answer_value: "YES", answer_label: "Yes" })).toEqual({
      value: "YES",
      valueLabel: "Yes",
    });
  });

  it("option question: falls back to label match when value differs (option set changed)", () => {
    // stored value "1" no longer exists, but the label "Yes" maps to current "YES"
    expect(resolveValue(yesNo, { answer_value: "1", answer_label: "Yes" })).toEqual({
      value: "YES",
      valueLabel: "Yes",
    });
  });

  it("option question: refuses to prefill when neither value nor label maps", () => {
    expect(resolveValue(yesNo, { answer_value: "MAYBE", answer_label: "Maybe" })).toBeNull();
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("handles zero vectors without NaN", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
