/** 计算器的全部输入(纯数据,UI 和导出共用) */
export interface ServiceFeeInputs {
  startDate: string; // 'YYYY-MM-DD'(用户原始选择)
  endDate: string; // 'YYYY-MM-DD'(用户原始选择)
  weeklyWorkHours: number;
  hourlyWage: number;
  taxWithheldPerPayroll: number; // 每个双周(每 2 个工作周)收一次
  monthlyPayrollFee: number; // 每个自然月收一次(默认 92)
  monthlyServiceCharge: number; // 每个月度周年日收一次(默认 120)
}

export type PayrollFeeType = "Monthly Payroll Fee" | "None";

export type WorkHoursAdjustment =
  | "Start Week Minimum Hours"
  | "Full Work Week"
  | "End Week Extended"
  | "No Adjustment";

/**
 * 工时行:一个自然工作周(周一–周日)。
 * 每周补足整周 Weekly Work Hours;Tax Withheld 按「每 2 个工作周一个双周」收取,
 * 落在每个双周的第 1 周(第 1、3、5… 周各 $100,其余 $0)。
 */
export interface WeekRow {
  index: number;
  workWeekStart: string;
  workWeekEnd: string;
  workWeekStartISO: string;
  workWeekEndISO: string;
  coveredStart: string;
  coveredEnd: string;
  coveredStartISO: string;
  coveredEndISO: string;
  actualWorkingDays: number;
  adjustedWorkingDays: number;
  weeklyWorkHours: number;
  workHours: number;
  hourlyWage: number;
  grossWages: number;
  taxWithheld: number; // 本周计入的 Tax($100 或 $0)
  adjustmentType: WorkHoursAdjustment;
}

/**
 * 费用行:每个涉及的自然月一行。
 * - Payroll Fee:每月固定 $92。
 * - Service Charge:仅当该月含「从 Start Date 起的月度周年收费日」且落在区间内时收一次 $120。
 * (Tax Withheld 已移到工时周表。)
 */
export interface FeeRow {
  monthKey: string;
  payrollMonth: string; // 'February 2026'
  coveredStart: string;
  coveredEnd: string;
  coveredStartISO: string;
  coveredEndISO: string;
  payrollFee: number;
  payrollFeeType: PayrollFeeType;
  serviceChargeDate: string; // 收费日期(MM/DD/YYYY);无则空串
  serviceChargeDateISO: string;
  serviceCharge: number;
  subtotal: number; // payrollFee + serviceCharge
}

export interface CalculationResult {
  totalCalendarDays: number;
  totalWorkingDays: number;
  totalWeekendDays: number;
  monthCount: number; // 涉及自然月数量(= Payroll Fee 次数)
  taxChargeCount: number; // Tax 收取次数(= ceil(工作周数 / 2))
  serviceChargeCount: number; // 月度周年收费次数(= Service Charge 次数)
  weeklyWorkHours: number;
  dailyWorkHours: number;
  workWeekCount: number;
  totalAdjustedWorkingDays: number;
  totalWorkHours: number;
  grossWages: number;
  totalTaxWithheld: number;
  totalPayrollFees: number;
  totalServiceCharge: number;
  grandTotal: number;
  workWeeks: WeekRow[];
  feeRows: FeeRow[];
  inputs: ServiceFeeInputs;
}
