import { describe, expect, it } from "vitest";

import { defaultTargetWeek, formatWeekRange } from "./week";

describe("formatWeekRange", () => {
  it("same-month Mon–Fri", () => {
    // Monday 2026-07-06 .. Friday 2026-07-10
    expect(formatWeekRange(new Date(2026, 6, 6))).toBe("July 6–10, 2026");
  });

  it("cross-month week spells out both months", () => {
    // Monday 2026-06-29 .. Friday 2026-07-03
    expect(formatWeekRange(new Date(2026, 5, 29))).toBe("June 29 – July 3, 2026");
  });

  it("cross-year week includes both years", () => {
    // Monday 2026-12-28 .. Friday 2027-01-01
    expect(formatWeekRange(new Date(2026, 11, 28))).toBe(
      "December 28, 2026 – January 1, 2027",
    );
  });
});

describe("defaultTargetWeek", () => {
  it("returns the current work week when base is a weekday", () => {
    // Wednesday 2026-07-08 -> that week's Mon–Fri
    expect(defaultTargetWeek(new Date(2026, 6, 8))).toBe("July 6–10, 2026");
  });

  it("rolls Saturday forward to next Monday's week", () => {
    // Saturday 2026-07-11 -> next Mon 2026-07-13 .. Fri 2026-07-17
    expect(defaultTargetWeek(new Date(2026, 6, 11))).toBe("July 13–17, 2026");
  });

  it("rolls Sunday forward to next Monday's week", () => {
    // Sunday 2026-07-12 -> next Mon 2026-07-13 .. Fri 2026-07-17
    expect(defaultTargetWeek(new Date(2026, 6, 12))).toBe("July 13–17, 2026");
  });
});
