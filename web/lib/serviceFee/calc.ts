import {
  DAY_MS,
  addDays,
  dayOfWeek,
  daysInMonthKey,
  diffDays,
  formatUS,
  isWeekday,
  lastOfMonth,
  mondayOf,
  monthKey,
  monthLabel,
  parseDate,
  toISO,
} from "./dateUtils";
import type {
  CalculationResult,
  FeeRow,
  PayrollFeeType,
  ServiceFeeInputs,
  WeekRow,
  WorkHoursAdjustment,
} from "./types";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const PAYROLL_CYCLE_DAYS = 14;

function countWeekdays(a: number, b: number): number {
  let c = 0;
  for (let ts = a; ts <= b; ts += DAY_MS) if (isWeekday(ts)) c++;
  return c;
}

interface Period {
  index: number;
  startTs: number;
  endTs: number;
  assignMonthKey: string;
  assignMonthLabel: string;
  sequenceInMonth: number;
  fee: number;
  feeType: PayrollFeeType;
}

interface FeeSegment {
  period: Period;
  monthKey: string;
  startTs: number;
  endTs: number;
  calendarDays: number;
  tax: number;
  fee: number;
  feeType: PayrollFeeType;
  sc: number;
}

/**
 * 收费计算核心(纯函数,确定性)。
 *
 * 两套独立的切割:
 *  - 工时(Work Hours / Working Days / Gross Wages):按自然工作周「周一–周日」切割,
 *    每个被原始选择区间触及的工作周都补足完整 Weekly Work Hours。首周不向 Start 之前补、
 *    末周顺延至周日。跨月不拆周。
 *  - 费用(Tax / Payroll Fee / Service Charge / 月份数 / Payroll Period 数):完全沿用原逻辑,
 *    基于用户「原始选择的 Start/End」计算。工作周末周顺延「不会」增加任何费用或月份/周期数量。
 */
export function calculateServiceFee(inp: ServiceFeeInputs): CalculationResult {
  const rangeStart = parseDate(inp.startDate);
  const rangeEnd = parseDate(inp.endDate);
  const cycleStart = parseDate(inp.payrollCycleStartDate);
  const weeklyWorkHours = inp.weeklyWorkHours;
  const wage = inp.hourlyWage;

  // ---------- 日期统计(原始选择区间) ----------
  const totalCalendarDays = diffDays(rangeStart, rangeEnd) + 1;
  let totalWorkingDays = 0;
  let totalWeekendDays = 0;
  const coveredDaysPerMonth = new Map<string, number>();
  for (let ts = rangeStart; ts <= rangeEnd; ts += DAY_MS) {
    if (isWeekday(ts)) totalWorkingDays++;
    else totalWeekendDays++;
    const mk = monthKey(ts);
    coveredDaysPerMonth.set(mk, (coveredDaysPerMonth.get(mk) ?? 0) + 1);
  }
  const monthCount = coveredDaysPerMonth.size;

  // ================= 费用(沿用原逻辑,基于原始选择区间) =================
  const offset =
    inp.assignPayrollFeeBy === "payDate" ? Math.max(0, inp.payDateOffsetDays || 0) : 0;
  const bufferDays = 31 + PAYROLL_CYCLE_DAYS + offset;
  const windowStart = rangeStart - bufferDays * DAY_MS;
  const windowEnd = rangeEnd + bufferDays * DAY_MS;
  const kStart = Math.floor(diffDays(cycleStart, windowStart) / PAYROLL_CYCLE_DAYS);

  const periods: Period[] = [];
  for (let k = kStart; ; k++) {
    const startTs = addDays(cycleStart, k * PAYROLL_CYCLE_DAYS);
    const endTs = addDays(startTs, PAYROLL_CYCLE_DAYS - 1);
    if (startTs > windowEnd) break;
    if (endTs < windowStart) continue;
    const assignTs = addDays(endTs, offset);
    periods.push({
      index: 0,
      startTs,
      endTs,
      assignMonthKey: monthKey(assignTs),
      assignMonthLabel: monthLabel(assignTs),
      sequenceInMonth: 0,
      fee: 0,
      feeType: "First",
    });
  }
  periods.sort((a, b) => a.startTs - b.startTs);
  const seqCounter = new Map<string, number>();
  for (const p of periods) {
    const c = (seqCounter.get(p.assignMonthKey) ?? 0) + 1;
    seqCounter.set(p.assignMonthKey, c);
    p.sequenceInMonth = c;
    if (c === 1) {
      p.fee = inp.firstPayrollFee;
      p.feeType = "First";
    } else {
      p.fee = inp.secondPayrollFee;
      p.feeType = "Second";
    }
  }
  const inRange = periods.filter((p) => p.endTs >= rangeStart && p.startTs <= rangeEnd);
  inRange.forEach((p, i) => (p.index = i + 1));
  const payrollPeriodCount = inRange.length;

  const monthCharge = new Map<string, number>();
  for (const [mk, covered] of coveredDaysPerMonth) {
    monthCharge.set(
      mk,
      inp.prorateServiceCharge
        ? round2((inp.monthlyServiceCharge * covered) / daysInMonthKey(mk))
        : round2(inp.monthlyServiceCharge),
    );
  }

  const segs: FeeSegment[] = [];
  for (const p of inRange) {
    const cs = Math.max(p.startTs, rangeStart);
    const ce = Math.min(p.endTs, rangeEnd);
    let s = cs;
    while (s <= ce) {
      const e = Math.min(lastOfMonth(s), ce);
      segs.push({
        period: p,
        monthKey: monthKey(s),
        startTs: s,
        endTs: e,
        calendarDays: diffDays(s, e) + 1,
        tax: 0,
        fee: 0,
        feeType: "None",
        sc: 0,
      });
      s = e + DAY_MS;
    }
  }
  const byPeriod = new Map<number, FeeSegment[]>();
  for (const s of segs) {
    const a = byPeriod.get(s.period.index) ?? [];
    a.push(s);
    byPeriod.set(s.period.index, a);
  }
  for (const a of byPeriod.values()) {
    const p = a[0].period;
    const t = a.find((s) => s.monthKey === p.assignMonthKey) ?? a[a.length - 1];
    t.tax = round2(inp.taxWithheldPerPayroll);
    t.fee = round2(p.fee);
    t.feeType = p.feeType;
  }
  const byMonth = new Map<string, FeeSegment[]>();
  for (const s of segs) {
    const a = byMonth.get(s.monthKey) ?? [];
    a.push(s);
    byMonth.set(s.monthKey, a);
  }
  for (const [mk, a] of byMonth) {
    const charge = monthCharge.get(mk) ?? 0;
    const td = a.reduce((x, s) => x + s.calendarDays, 0);
    let alloc = 0;
    a.forEach((s, i) => {
      if (i === a.length - 1) s.sc = round2(charge - alloc);
      else {
        s.sc = round2((charge * s.calendarDays) / td);
        alloc = round2(alloc + s.sc);
      }
    });
  }

  const feeRows: FeeRow[] = segs.map((s) => ({
    payrollNumber: s.period.index,
    periodStart: formatUS(s.period.startTs),
    periodEnd: formatUS(s.period.endTs),
    periodStartISO: toISO(s.period.startTs),
    periodEndISO: toISO(s.period.endTs),
    payrollMonth: s.period.assignMonthLabel,
    sequenceInMonth: s.period.sequenceInMonth,
    coveredStart: formatUS(s.startTs),
    coveredEnd: formatUS(s.endTs),
    coveredStartISO: toISO(s.startTs),
    coveredEndISO: toISO(s.endTs),
    calendarDaysCovered: s.calendarDays,
    taxWithheld: s.tax,
    payrollFeeType: s.feeType,
    payrollFee: s.fee,
    serviceCharge: s.sc,
    subtotal: round2(s.tax + s.fee + s.sc),
  }));
  const fsum = (f: (r: FeeRow) => number) => round2(feeRows.reduce((a, r) => a + f(r), 0));
  const totalTaxWithheld = fsum((r) => r.taxWithheld);
  const totalPayrollFees = fsum((r) => r.payrollFee);
  const totalServiceCharge = fsum((r) => r.serviceCharge);

  // ================= 工时(按自然工作周 周一–周日) =================
  const firstMon = mondayOf(rangeStart);
  const lastMon = mondayOf(rangeEnd);
  const workWeekCount = diffDays(firstMon, lastMon) / 7 + 1;

  const workWeeks: WeekRow[] = [];
  for (let k = 0; k < workWeekCount; k++) {
    const weekMon = addDays(firstMon, k * 7);
    const weekSun = addDays(weekMon, 6);
    const isFirst = k === 0;
    const isLast = k === workWeekCount - 1;
    const displayedStart = isFirst ? rangeStart : weekMon; // 首周不向 Start 之前补
    const displayedEnd = weekSun; // 末周顺延至周日

    const adjustedWorkingDays = countWeekdays(displayedStart, weekSun);
    const actualStart = Math.max(weekMon, rangeStart);
    const actualEnd = Math.min(weekSun, rangeEnd);
    const actualWorkingDays = countWeekdays(actualStart, actualEnd);

    let adjustmentType: WorkHoursAdjustment;
    if (isFirst && dayOfWeek(rangeStart) !== 1) adjustmentType = "Start Week Minimum Hours";
    else if (isLast && adjustedWorkingDays > actualWorkingDays) adjustmentType = "End Week Extended";
    else if (adjustedWorkingDays === 5) adjustmentType = "Full Work Week";
    else adjustmentType = "No Adjustment";

    workWeeks.push({
      index: k + 1,
      workWeekStart: formatUS(displayedStart),
      workWeekEnd: formatUS(displayedEnd),
      workWeekStartISO: toISO(displayedStart),
      workWeekEndISO: toISO(displayedEnd),
      coveredStart: formatUS(actualStart),
      coveredEnd: formatUS(actualEnd),
      coveredStartISO: toISO(actualStart),
      coveredEndISO: toISO(actualEnd),
      actualWorkingDays,
      adjustedWorkingDays,
      weeklyWorkHours,
      workHours: weeklyWorkHours,
      hourlyWage: round2(wage),
      grossWages: round2(weeklyWorkHours * wage),
      adjustmentType,
    });
  }

  const totalWorkHours = round2(workWeeks.reduce((a, w) => a + w.workHours, 0));
  const grossWages = round2(workWeeks.reduce((a, w) => a + w.grossWages, 0));
  const totalAdjustedWorkingDays = workWeeks.reduce((a, w) => a + w.adjustedWorkingDays, 0);

  const grandTotal = round2(
    grossWages + totalTaxWithheld + totalPayrollFees + totalServiceCharge,
  );

  return {
    totalCalendarDays,
    totalWorkingDays,
    totalWeekendDays,
    payrollPeriodCount,
    monthCount,
    weeklyWorkHours,
    dailyWorkHours: round2(weeklyWorkHours / 5),
    workWeekCount,
    totalAdjustedWorkingDays,
    totalWorkHours,
    grossWages,
    totalTaxWithheld,
    totalPayrollFees,
    totalServiceCharge,
    grandTotal,
    workWeeks,
    feeRows,
    inputs: inp,
  };
}
