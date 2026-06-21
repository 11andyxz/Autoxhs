import { describe, expect, it } from "vitest";

import { calculateServiceFee, round2 } from "./calc";
import type { ServiceFeeInputs } from "./types";

const base: ServiceFeeInputs = {
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  weeklyWorkHours: 20,
  hourlyWage: 19,
  taxWithheldPerPayroll: 100,
  monthlyPayrollFee: 92,
  monthlyServiceCharge: 120,
};

type R = ReturnType<typeof calculateServiceFee>;

function expectConsistent(r: R) {
  expect(round2(r.workWeeks.reduce((a, w) => a + w.grossWages, 0))).toBe(r.grossWages);
  expect(round2(r.workWeeks.reduce((a, w) => a + w.workHours, 0))).toBe(r.totalWorkHours);
  expect(round2(r.workWeeks.reduce((a, w) => a + w.taxWithheld, 0))).toBe(r.totalTaxWithheld);
  expect(round2(r.feeRows.reduce((a, x) => a + x.payrollFee, 0))).toBe(r.totalPayrollFees);
  expect(round2(r.feeRows.reduce((a, x) => a + x.serviceCharge, 0))).toBe(r.totalServiceCharge);
  expect(round2(r.grossWages + r.totalTaxWithheld + r.totalPayrollFees + r.totalServiceCharge)).toBe(
    r.grandTotal,
  );
  // 不变量:Tax = ceil(工作周/2) × 单价;Payroll = 月数 × 单价;SC = 周年次数 × 单价
  expect(r.taxChargeCount).toBe(Math.ceil(r.workWeekCount / 2));
  expect(r.totalTaxWithheld).toBe(round2(Math.ceil(r.workWeekCount / 2) * r.inputs.taxWithheldPerPayroll));
  expect(r.totalPayrollFees).toBe(round2(r.monthCount * r.inputs.monthlyPayrollFee));
  expect(r.totalServiceCharge).toBe(round2(r.serviceChargeCount * r.inputs.monthlyServiceCharge));
}

describe("Tax 按每 2 个工作周收一次(落在第 1、3、5… 周)", () => {
  const r = calculateServiceFee(base);
  it("June:5 周 → ceil(5/2)=3 次 → $300", () => {
    expect(r.workWeekCount).toBe(5);
    expect(r.taxChargeCount).toBe(3);
    expect(r.totalTaxWithheld).toBe(300);
  });
  it("Tax 落在奇数周(1/3/5),偶数周为 0", () => {
    expect(r.workWeeks.map((w) => w.taxWithheld)).toEqual([100, 0, 100, 0, 100]);
  });
  it("Payroll 1 月 = 92;SC 周年 06/01 一次 = 120", () => {
    expect(r.monthCount).toBe(1);
    expect(r.totalPayrollFees).toBe(92);
    expect(r.serviceChargeCount).toBe(1);
    expect(r.totalServiceCharge).toBe(120);
  });
  it("Grand Total = 1900 + 300 + 92 + 120 = 2412", () => {
    expect(r.grandTotal).toBe(2412);
  });
  it("一致性", () => expectConsistent(r));
});

describe("大例子 02/17 – 06/18(wage 17)", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-06-18", hourlyWage: 17 });
  it("18 个工作周 → Tax ceil(18/2)=9 → $900", () => {
    expect(r.workWeekCount).toBe(18);
    expect(r.taxChargeCount).toBe(9);
    expect(r.totalTaxWithheld).toBe(900);
  });
  it("Payroll 5 月 = 460;SC 5 次 = 600", () => {
    expect(r.monthCount).toBe(5);
    expect(r.totalPayrollFees).toBe(460);
    expect(r.serviceChargeCount).toBe(5);
    expect(r.totalServiceCharge).toBe(600);
  });
  it("Gross 18 × 20 × 17 = 6120;Grand = 6120 + 900 + 460 + 600 = 8080", () => {
    expect(r.grossWages).toBe(6120);
    expect(r.grandTotal).toBe(8080);
  });
  it("一致性", () => expectConsistent(r));
});

describe("Tax 偶数周数整除", () => {
  // 06/01 – 06/14 = 2 个工作周 → 1 次 tax
  const r = calculateServiceFee({ ...base, endDate: "2026-06-14" });
  it("2 周 → 1 次 $100", () => {
    expect(r.workWeekCount).toBe(2);
    expect(r.taxChargeCount).toBe(1);
    expect(r.totalTaxWithheld).toBe(100);
    expect(r.workWeeks.map((w) => w.taxWithheld)).toEqual([100, 0]);
  });
  it("一致性", () => expectConsistent(r));
});

describe("Payroll Fee 每月一次(02/28 – 03/01 跨月)", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-02-28", endDate: "2026-03-01" });
  it("2 个月 = 184", () => {
    expect(r.monthCount).toBe(2);
    expect(r.totalPayrollFees).toBe(184);
  });
  it("一致性", () => expectConsistent(r));
});

describe("Service Charge 月度周年规则", () => {
  it("02/17 – 03/16 只有 02/17 = 120", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-03-16" });
    expect(r.serviceChargeCount).toBe(1);
    expect(r.totalServiceCharge).toBe(120);
  });
  it("02/17 – 03/17 含两端 = 240", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-03-17" });
    expect(r.serviceChargeCount).toBe(2);
    expect(r.totalServiceCharge).toBe(240);
  });
  it("月末日:01/31 → 01/31, 02/28, 03/31", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-01-31", endDate: "2026-03-31" });
    expect(r.serviceChargeCount).toBe(3);
    expect(r.feeRows.some((x) => x.serviceChargeDate === "02/28/2026")).toBe(true);
  });
});

describe("工作周顺延不增加费用(06/29 – 06/30)", () => {
  const r = calculateServiceFee({ ...base, startDate: "2026-06-29", endDate: "2026-06-30" });
  it("工作周延到 7/5,费用仍按 6 月", () => {
    expect(r.workWeeks[0].workWeekEndISO).toBe("2026-07-05");
    expect(r.workWeekCount).toBe(1);
    expect(r.taxChargeCount).toBe(1);
    expect(r.totalTaxWithheld).toBe(100);
    expect(r.monthCount).toBe(1);
    expect(r.totalPayrollFees).toBe(92);
    expect(r.serviceChargeCount).toBe(1);
    expect(r.totalServiceCharge).toBe(120);
    expect(r.grandTotal).toBe(692); // 380 + 100 + 92 + 120
  });
  it("一致性", () => expectConsistent(r));
});

describe("工时(首周/末周)仍正确", () => {
  it("首周 02/17 – 02/22,4 工作日 20 工时", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-02-22", hourlyWage: 17 });
    const w = r.workWeeks[0];
    expect(w.adjustedWorkingDays).toBe(4);
    expect(w.workHours).toBe(20);
    expect(w.grossWages).toBe(340);
    expect(w.adjustmentType).toBe("Start Week Minimum Hours");
  });
  it("末周 06/15 – 06/18 顺延到 06/21", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-06-15", endDate: "2026-06-18" });
    const w = r.workWeeks[0];
    expect(w.workWeekEnd).toBe("06/21/2026");
    expect(w.adjustedWorkingDays).toBe(5);
    expect(w.adjustmentType).toBe("End Week Extended");
  });
});

describe("Actual End Date(末周顺延)", () => {
  it("06/29 – 06/30 → Actual End Date = 2026-07-05;Input End 不变", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-06-29", endDate: "2026-06-30" });
    expect(r.inputEndDateISO).toBe("2026-06-30");
    expect(r.actualEndDateISO).toBe("2026-07-05");
  });
  it("无顺延时 Actual End = 该周周日", () => {
    const r = calculateServiceFee({ ...base, startDate: "2026-06-01", endDate: "2026-06-30" });
    expect(r.actualEndDateISO).toBe("2026-07-05"); // 06/30 周二 -> 周日 07/05
  });
});

describe("跨记录去重(Tax 按周 / Payroll & Service 按月)", () => {
  it("无 prior 时与默认一致", () => {
    const a = calculateServiceFee(base);
    const b = calculateServiceFee(base, { payrollMonths: [], serviceMonths: [], taxWeeks: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("Payroll 已收月份置 0", () => {
    const r = calculateServiceFee(base, {
      payrollMonths: ["2026-06"],
      serviceMonths: [],
      taxWeeks: [],
    });
    expect(r.totalPayrollFees).toBe(0);
    expect(r.feeRows[0].payrollAlreadyBilled).toBe(true);
    expect(r.chargedPayrollMonths).toEqual([]);
  });

  it("Service 已收月份置 0", () => {
    const r = calculateServiceFee(base, {
      payrollMonths: [],
      serviceMonths: ["2026-06"],
      taxWeeks: [],
    });
    expect(r.totalServiceCharge).toBe(0);
    expect(r.serviceChargeCount).toBe(0);
  });

  it("Tax 已收的周不再计费", () => {
    // June 工作周 mondays: 06/01,06/08,06/15,06/22,06/29;收过前两周
    const r = calculateServiceFee(base, {
      payrollMonths: [],
      serviceMonths: [],
      taxWeeks: ["2026-06-01", "2026-06-08"],
    });
    // 新增周 = 06/15,06/22,06/29 共 3 周 -> ceil(3/2)=2 次 -> 200
    expect(r.totalTaxWithheld).toBe(200);
    expect(r.taxChargeCount).toBe(2);
    expect(r.workWeeks[0].taxAlreadyBilled).toBe(true);
    expect(r.workWeeks[1].taxAlreadyBilled).toBe(true);
    expect(r.billedTaxWeeks).toEqual(["2026-06-15", "2026-06-22", "2026-06-29"]);
  });

  it("连续计费场景(§5):record2 只收新增的月/周", () => {
    const r1 = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-03-17" });
    const r2 = calculateServiceFee(
      { ...base, startDate: "2026-03-17", endDate: "2026-04-17" },
      {
        payrollMonths: r1.chargedPayrollMonths,
        serviceMonths: r1.chargedServiceMonths,
        taxWeeks: r1.billedTaxWeeks,
        taxAnchor: r1.billedTaxWeeks[0], // 2026-02-16
      },
    );
    expect(r2.totalPayrollFees).toBe(92); // 只有 4 月(3 月已收)
    expect(r2.totalServiceCharge).toBe(120); // 只有 04/17(03/17 已收)
    expect(r2.totalTaxWithheld).toBe(200); // 新增 2 个双周
  });

  it("回归(用户 bug):03/23–03/29 属于已收双周,Tax 收 0", () => {
    const r1 = calculateServiceFee({ ...base, startDate: "2026-02-17", endDate: "2026-03-17" });
    expect(r1.billedTaxWeeks[0]).toBe("2026-02-16");
    const r2 = calculateServiceFee(
      { ...base, startDate: "2026-03-23", endDate: "2026-03-29" },
      {
        payrollMonths: r1.chargedPayrollMonths,
        serviceMonths: r1.chargedServiceMonths,
        taxWeeks: r1.billedTaxWeeks,
        taxAnchor: r1.billedTaxWeeks[0], // 锚 = 02/16
      },
    );
    expect(r2.workWeekCount).toBe(1);
    expect(r2.totalTaxWithheld).toBe(0); // 03/16–03/22 已收过,03/23 是同一双周第二周
    expect(r2.taxChargeCount).toBe(0);
    expect(r2.workWeeks[0].taxAlreadyBilled).toBe(true);
  });
});

describe("确定性", () => {
  it("相同输入两次一致", () => {
    expect(JSON.stringify(calculateServiceFee(base))).toBe(JSON.stringify(calculateServiceFee(base)));
  });
});
