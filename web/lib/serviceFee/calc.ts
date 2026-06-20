import {
  DAY_MS,
  addDays,
  dayOfWeek,
  diffDays,
  formatUS,
  isWeekday,
  mondayOf,
  monthKey,
  monthLabel,
  parseDate,
  toISO,
} from "./dateUtils";
import type {
  CalculationResult,
  FeeRow,
  PriorCharges,
  ServiceFeeInputs,
  WeekRow,
  WorkHoursAdjustment,
} from "./types";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const EMPTY_PRIOR: PriorCharges = { payrollMonths: [], serviceMonths: [], taxWeeks: [] };

function countWeekdays(a: number, b: number): number {
  let c = 0;
  for (let ts = a; ts <= b; ts += DAY_MS) if (isWeekday(ts)) c++;
  return c;
}

function daysInYearMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Service Charge 收费日:从 Start Date 当天起每月同一天(月末日不存在取当月最后一天),仅保留落在 [start,end] 内的 */
function serviceChargeDates(startTs: number, endTs: number): number[] {
  const sd = new Date(startTs);
  const day = sd.getUTCDate();
  let y = sd.getUTCFullYear();
  let m = sd.getUTCMonth();
  const out: number[] = [];
  for (let i = 0; i < 1200; i++) {
    const d = Math.min(day, daysInYearMonth(y, m));
    const ts = Date.UTC(y, m, d);
    if (ts > endTs) break;
    if (ts >= startTs) out.push(ts);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/**
 * 收费计算核心(纯函数,确定性)。
 *
 * 工时(按自然工作周 周一–周日):每周补足整周 Weekly Work Hours;首周不向前补、末周顺延至周日。
 *
 * 费用(基于原始选择区间;`prior` 为该客户已保存过的费用键,用于跨记录去重):
 *  - Tax:每个工作周(周一锚定)每客户只计一次;Tax = ⌈新增工作周/2⌉ × 单价,落在新增周的第 1、3、5…
 *  - Payroll Fee:每个自然月 $92,已收过的月置 0。
 *  - Service Charge:从 Start 起每月同一天 $120,已收过的月置 0。
 *  Gross / 工时不去重。工作周顺延不增加任何费用。
 */
export function calculateServiceFee(
  inp: ServiceFeeInputs,
  prior: PriorCharges = EMPTY_PRIOR,
): CalculationResult {
  const rangeStart = parseDate(inp.startDate);
  const rangeEnd = parseDate(inp.endDate);
  const weeklyWorkHours = inp.weeklyWorkHours;
  const wage = inp.hourlyWage;

  const priorTaxWeeks = new Set(prior.taxWeeks);
  const priorPayrollMonths = new Set(prior.payrollMonths);
  const priorServiceMonths = new Set(prior.serviceMonths);

  // ---------- 日期统计 + 涉及自然月(有序) ----------
  const totalCalendarDays = diffDays(rangeStart, rangeEnd) + 1;
  let totalWorkingDays = 0;
  let totalWeekendDays = 0;
  const monthOrder: string[] = [];
  const monthSeen = new Set<string>();
  for (let ts = rangeStart; ts <= rangeEnd; ts += DAY_MS) {
    if (isWeekday(ts)) totalWorkingDays++;
    else totalWeekendDays++;
    const mk = monthKey(ts);
    if (!monthSeen.has(mk)) {
      monthSeen.add(mk);
      monthOrder.push(mk);
    }
  }
  const monthCount = monthOrder.length;

  // ================= 工时 + Tax(按自然工作周) =================
  const firstMon = mondayOf(rangeStart);
  const lastMon = mondayOf(rangeEnd);
  const workWeekCount = diffDays(firstMon, lastMon) / 7 + 1;

  const billedTaxWeeks: string[] = []; // 本次新覆盖的周(用于持久化)
  let newWeekCount = 0;

  const workWeeks: WeekRow[] = [];
  for (let i = 0; i < workWeekCount; i++) {
    const weekMon = addDays(firstMon, i * 7);
    const weekSun = addDays(weekMon, 6);
    const weekMondayISO = toISO(weekMon);
    const isFirst = i === 0;
    const isLast = i === workWeekCount - 1;
    const displayedStart = isFirst ? rangeStart : weekMon;

    const adjustedWorkingDays = countWeekdays(displayedStart, weekSun);
    const actualStart = Math.max(weekMon, rangeStart);
    const actualEnd = Math.min(weekSun, rangeEnd);
    const actualWorkingDays = countWeekdays(actualStart, actualEnd);

    let adjustmentType: WorkHoursAdjustment;
    if (isFirst && dayOfWeek(rangeStart) !== 1) adjustmentType = "Start Week Minimum Hours";
    else if (isLast && adjustedWorkingDays > actualWorkingDays) adjustmentType = "End Week Extended";
    else if (adjustedWorkingDays === 5) adjustmentType = "Full Work Week";
    else adjustmentType = "No Adjustment";

    const taxAlreadyBilled = priorTaxWeeks.has(weekMondayISO);
    let taxWithheld = 0;
    if (!taxAlreadyBilled) {
      newWeekCount += 1;
      billedTaxWeeks.push(weekMondayISO);
      taxWithheld = newWeekCount % 2 === 1 ? round2(inp.taxWithheldPerPayroll) : 0;
    }

    workWeeks.push({
      index: i + 1,
      workWeekStart: formatUS(displayedStart),
      workWeekEnd: formatUS(weekSun),
      workWeekStartISO: toISO(displayedStart),
      workWeekEndISO: toISO(weekSun),
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
      taxWithheld,
      taxAlreadyBilled,
      adjustmentType,
    });
  }

  const totalWorkHours = round2(workWeeks.reduce((a, w) => a + w.workHours, 0));
  const grossWages = round2(workWeeks.reduce((a, w) => a + w.grossWages, 0));
  const totalAdjustedWorkingDays = workWeeks.reduce((a, w) => a + w.adjustedWorkingDays, 0);
  const totalTaxWithheld = round2(workWeeks.reduce((a, w) => a + w.taxWithheld, 0));
  const taxChargeCount = workWeeks.filter((w) => w.taxWithheld > 0).length;
  const actualEndDateISO = workWeeks[workWeeks.length - 1].workWeekEndISO;

  // ================= 费用(每个自然月一行,带去重) =================
  const scDates = serviceChargeDates(rangeStart, rangeEnd);
  const scByMonth = new Map<string, number>();
  for (const dts of scDates) scByMonth.set(monthKey(dts), dts);

  const chargedPayrollMonths: string[] = [];
  const chargedServiceMonths: string[] = [];

  const feeRows: FeeRow[] = monthOrder.map((mk) => {
    const [y, m] = mk.split("-").map(Number);
    const monthFirst = Date.UTC(y, m - 1, 1);
    const monthLast = Date.UTC(y, m, 0);
    const coveredStartTs = Math.max(monthFirst, rangeStart);
    const coveredEndTs = Math.min(monthLast, rangeEnd);
    const scTs = scByMonth.get(mk) ?? null;

    const payrollAlreadyBilled = priorPayrollMonths.has(mk);
    const payrollFee = payrollAlreadyBilled ? 0 : round2(inp.monthlyPayrollFee);
    if (!payrollAlreadyBilled) chargedPayrollMonths.push(mk);

    const serviceAlreadyBilled = scTs !== null && priorServiceMonths.has(mk);
    const serviceCharge = scTs !== null && !serviceAlreadyBilled ? round2(inp.monthlyServiceCharge) : 0;
    if (scTs !== null && !serviceAlreadyBilled) chargedServiceMonths.push(mk);

    return {
      monthKey: mk,
      payrollMonth: monthLabel(monthFirst),
      coveredStart: formatUS(coveredStartTs),
      coveredEnd: formatUS(coveredEndTs),
      coveredStartISO: toISO(coveredStartTs),
      coveredEndISO: toISO(coveredEndTs),
      payrollFee,
      payrollFeeType: payrollFee > 0 ? "Monthly Payroll Fee" : "None",
      payrollAlreadyBilled,
      serviceChargeDate: scTs !== null ? formatUS(scTs) : "",
      serviceChargeDateISO: scTs !== null ? toISO(scTs) : "",
      serviceCharge,
      serviceAlreadyBilled,
      subtotal: round2(payrollFee + serviceCharge),
    };
  });

  const totalPayrollFees = round2(feeRows.reduce((a, r) => a + r.payrollFee, 0));
  const totalServiceCharge = round2(feeRows.reduce((a, r) => a + r.serviceCharge, 0));
  const serviceChargeCount = chargedServiceMonths.length;

  const grandTotal = round2(
    grossWages + totalTaxWithheld + totalPayrollFees + totalServiceCharge,
  );

  return {
    totalCalendarDays,
    totalWorkingDays,
    totalWeekendDays,
    monthCount,
    taxChargeCount,
    serviceChargeCount,
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
    inputStartDate: formatUS(rangeStart),
    inputStartDateISO: toISO(rangeStart),
    inputEndDate: formatUS(rangeEnd),
    inputEndDateISO: toISO(rangeEnd),
    actualEndDate: formatUS(parseDate(actualEndDateISO)),
    actualEndDateISO,
    chargedPayrollMonths,
    chargedServiceMonths,
    billedTaxWeeks,
    workWeeks,
    feeRows,
    inputs: inp,
  };
}
