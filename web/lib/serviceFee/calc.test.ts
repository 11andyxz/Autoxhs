import { describe, expect, it } from "vitest";

import { calculateServiceFee, round2 } from "./calc";
import type { ServiceFeeInputs } from "./types";

const base: ServiceFeeInputs = {
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  payrollCycleStartDate: "2026-06-01",
  weeklyWorkHours: 20,
  hourlyWage: 19,
  taxWithheldPerPayroll: 100,
  firstPayrollFee: 92,
  secondPayrollFee: 12,
  monthlyServiceCharge: 120,
  prorateServiceCharge: false,
  assignPayrollFeeBy: "periodEnd",
  payDateOffsetDays: 0,
};

type R = ReturnType<typeof calculateServiceFee>;

/** 一致性:工时来自周表、费用来自费用表,Grand Total 为四项之和 */
function expectConsistent(r: R) {
  expect(round2(r.workWeeks.reduce((a, w) => a + w.grossWages, 0))).toBe(r.grossWages);
  expect(round2(r.workWeeks.reduce((a, w) => a + w.workHours, 0))).toBe(r.totalWorkHours);
  expect(round2(r.feeRows.reduce((a, x) => a + x.taxWithheld, 0))).toBe(r.totalTaxWithheld);
  expect(round2(r.feeRows.reduce((a, x) => a + x.payrollFee, 0))).toBe(r.totalPayrollFees);
  expect(round2(r.feeRows.reduce((a, x) => a + x.serviceCharge, 0))).toBe(r.totalServiceCharge);
  expect(
    round2(r.grossWages + r.totalTaxWithheld + r.totalPayrollFees + r.totalServiceCharge),
  ).toBe(r.grandTotal);
  // 每周工时恒为整周 Weekly Work Hours
  for (const w of r.workWeeks) expect(w.workHours).toBe(r.weeklyWorkHours);
}

describe("完整单月 June 2026(按工作周)", () => {
  const r = calculateServiceFee(base);
  it("工作周与工时:5 周 × 20 = 100,gross = 1900", () => {
    expect(r.workWeekCount).toBe(5);
    expect(r.totalWorkHours).toBe(100);
    expect(r.grossWages).toBe(1900); // 5 × 20 × 19
    expect(r.totalAdjustedWorkingDays).toBe(25);
    expect(r.totalWorkingDays).toBe(22); // 实际 Mon-Fri 不变
  });
  it("费用保持不变", () => {
    expect(r.payrollPeriodCount).toBe(3);
    expect(r.totalTaxWithheld).toBe(300);
    expect(r.totalPayrollFees).toBe(196);
    expect(r.totalServiceCharge).toBe(120);
    expect(r.monthCount).toBe(1);
  });
  it("Grand Total = 1900 + 300 + 196 + 120 = 2516", () => {
    expect(r.grandTotal).toBe(2516);
  });
  it("一致性", () => expectConsistent(r));
});

describe("首周不完整 + 同一周(02/17 周二 – 02/22 周日)", () => {
  const r = calculateServiceFee({
    ...base,
    startDate: "2026-02-17",
    endDate: "2026-02-22",
    payrollCycleStartDate: "2026-02-02",
    hourlyWage: 17,
  });
  it("一周,Working Days 4,Work Hours 20,Gross 340", () => {
    expect(r.workWeekCount).toBe(1);
    const w = r.workWeeks[0];
    expect(w.adjustedWorkingDays).toBe(4);
    expect(w.workHours).toBe(20);
    expect(w.grossWages).toBe(340); // 20 × 17
    expect(w.adjustmentType).toBe("Start Week Minimum Hours");
    expect(w.workWeekStart).toBe("02/17/2026");
    expect(w.workWeekEnd).toBe("02/22/2026");
    expect(r.grossWages).toBe(340);
  });
  it("一致性", () => expectConsistent(r));
});

describe("末周顺延(06/15 周一 – 06/18 周四)", () => {
  const r = calculateServiceFee({
    ...base,
    startDate: "2026-06-15",
    endDate: "2026-06-18",
  });
  it("顺延到周日,Working Days 补到 5,Work Hours 20", () => {
    expect(r.workWeekCount).toBe(1);
    const w = r.workWeeks[0];
    expect(w.workWeekStart).toBe("06/15/2026");
    expect(w.workWeekEnd).toBe("06/21/2026"); // 顺延至周日
    expect(w.actualWorkingDays).toBe(4); // 周一-周四
    expect(w.adjustedWorkingDays).toBe(5); // 含周五
    expect(w.workHours).toBe(20);
    expect(w.adjustmentType).toBe("End Week Extended");
  });
  it("一致性", () => expectConsistent(r));
});

describe("中间周跨月不拆(02/23 周一 – 03/01 周日)", () => {
  const r = calculateServiceFee({
    ...base,
    startDate: "2026-02-23",
    endDate: "2026-03-01",
    payrollCycleStartDate: "2026-02-02",
  });
  it("一个工作周,跨 2 月但不拆周", () => {
    expect(r.workWeekCount).toBe(1);
    expect(r.workWeeks[0].workWeekStart).toBe("02/23/2026");
    expect(r.workWeeks[0].workWeekEnd).toBe("03/01/2026");
    expect(r.workWeeks[0].adjustedWorkingDays).toBe(5);
    expect(r.monthCount).toBe(2); // 费用仍按 2 个月算,但工时只有一周
  });
  it("一致性", () => expectConsistent(r));
});

describe("§6 末周顺延不得扩大费用范围(06/29 周一 – 06/30 周二)", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-06-29", endDate: "2026-06-30" });
  it("工作周顺延到 7/5,但费用仍按 6 月算", () => {
    expect(r.workWeekCount).toBe(1);
    expect(r.workWeeks[0].workWeekEndISO).toBe("2026-07-05"); // 顺延进 7 月
    expect(r.workWeeks[0].workHours).toBe(20);
    // 费用范围不被扩大:仍只有 6 月
    expect(r.monthCount).toBe(1);
    expect(r.payrollPeriodCount).toBe(1);
    expect(r.totalServiceCharge).toBe(120); // 不是 240
    expect(r.totalTaxWithheld).toBe(100);
    expect(r.totalPayrollFees).toBe(92);
  });
  it("Grand Total = 380 + 100 + 92 + 120 = 692", () => {
    expect(r.grandTotal).toBe(692);
  });
  it("一致性", () => expectConsistent(r));
});

describe("整段都是周末(06/06 周六 – 06/07 周日)", () => {
  // 新逻辑:仍算 1 个工作周、补足整周工时(0 工作日但 20 小时)。
  const r = calculateServiceFee({ ...base, startDate: "2026-06-06", endDate: "2026-06-07" });
  it("1 周 / 20 工时 / 0 实际工作日", () => {
    expect(r.workWeekCount).toBe(1);
    expect(r.workWeeks[0].adjustedWorkingDays).toBe(0);
    expect(r.totalWorkHours).toBe(20);
    expect(r.grossWages).toBe(380);
    expect(r.totalWorkingDays).toBe(0);
    expect(r.totalTaxWithheld).toBe(100);
    expect(r.totalPayrollFees).toBe(92);
    expect(r.totalServiceCharge).toBe(120);
  });
  it("一致性", () => expectConsistent(r));
});

describe("跨月 June 10 – July 5", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-06-10", endDate: "2026-07-05" });
  it("工时 4 周;费用 2 月不变", () => {
    expect(r.workWeekCount).toBe(4);
    expect(r.grossWages).toBe(1520); // 4 × 20 × 19
    expect(r.monthCount).toBe(2);
    expect(r.totalServiceCharge).toBe(240);
    expect(r.payrollPeriodCount).toBe(3);
    expect(r.totalPayrollFees).toBe(196);
    expect(r.totalTaxWithheld).toBe(300);
  });
  it("一致性", () => expectConsistent(r));
});

describe("Service Charge 比例(06/10–06/30 prorate on)", () => {
  const r = calculateServiceFee({
    ...base,
    startDate: "2026-06-10",
    endDate: "2026-06-30",
    prorateServiceCharge: true,
  });
  it("84.00 不变", () => {
    expect(r.monthCount).toBe(1);
    expect(r.totalServiceCharge).toBe(84);
  });
  it("一致性", () => expectConsistent(r));
});

describe("只覆盖某月第二个 Payroll(06/15–06/28)", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-06-15", endDate: "2026-06-28" });
  it("费用只收第二笔 $12", () => {
    expect(r.payrollPeriodCount).toBe(1);
    expect(r.totalPayrollFees).toBe(12);
    expect(r.feeRows[0].payrollFeeType).toBe("Second");
    expect(r.feeRows[0].sequenceInMonth).toBe(2);
  });
  it("工时 2 周", () => {
    expect(r.workWeekCount).toBe(2);
    expect(r.grossWages).toBe(760); // 2 × 20 × 19
  });
  it("一致性", () => expectConsistent(r));
});

describe("某月 3 个 Payroll,只触及第 3 个(07/20–07/31,cycle 01/01)", () => {
  const r = calculateServiceFee({
    ...base,
    startDate: "2026-07-20",
    endDate: "2026-07-31",
    payrollCycleStartDate: "2026-01-01",
  });
  it("费用:第 3 个 = July seq3 / Second", () => {
    const third = r.feeRows.find((x) => x.periodEndISO === "2026-07-29");
    expect(third?.sequenceInMonth).toBe(3);
    expect(third?.payrollFeeType).toBe("Second");
    expect(third?.payrollFee).toBe(12);
    expect(r.totalPayrollFees).toBe(104); // 12 + 92
    expect(r.totalTaxWithheld).toBe(200);
    expect(r.monthCount).toBe(1);
  });
  it("一致性", () => expectConsistent(r));
});

describe("确定性(页面/Excel 一致前提)", () => {
  it("相同输入两次调用完全一致", () => {
    expect(JSON.stringify(calculateServiceFee(base))).toBe(
      JSON.stringify(calculateServiceFee(base)),
    );
  });
});
