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

/** 该客户「已经保存(收过)」的费用键,用于跨记录去重 */
export interface PriorCharges {
  payrollMonths: string[]; // 'YYYY-MM'
  serviceMonths: string[]; // 'YYYY-MM'
  taxWeeks: string[]; // 'YYYY-MM-DD'(工作周的周一)
}

export type PayrollFeeType = "Monthly Payroll Fee" | "None";

export type WorkHoursAdjustment =
  | "Start Week Minimum Hours"
  | "Full Work Week"
  | "End Week Extended"
  | "No Adjustment";

/** 工时行:一个自然工作周(周一–周日)。 */
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
  taxAlreadyBilled: boolean; // 该周已在之前的记录中收过 Tax
  adjustmentType: WorkHoursAdjustment;
}

/** 费用行:每个涉及的自然月一行。 */
export interface FeeRow {
  monthKey: string;
  payrollMonth: string; // 'February 2026'
  coveredStart: string;
  coveredEnd: string;
  coveredStartISO: string;
  coveredEndISO: string;
  payrollFee: number;
  payrollFeeType: PayrollFeeType;
  payrollAlreadyBilled: boolean; // 该月 Payroll Fee 已在之前记录收过
  serviceChargeDate: string; // 收费日期(MM/DD/YYYY);无则空串
  serviceChargeDateISO: string;
  serviceCharge: number;
  serviceAlreadyBilled: boolean; // 该月 Service Charge 已在之前记录收过
  subtotal: number; // payrollFee + serviceCharge
}

export interface CalculationResult {
  totalCalendarDays: number;
  totalWorkingDays: number;
  totalWeekendDays: number;
  monthCount: number;
  taxChargeCount: number; // 本次实际收取 Tax 的次数
  serviceChargeCount: number; // 本次实际收取 Service Charge 的次数
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
  // 日期
  inputStartDate: string;
  inputStartDateISO: string;
  inputEndDate: string;
  inputEndDateISO: string;
  actualEndDate: string; // 最后工作周顺延到的周日
  actualEndDateISO: string;
  // 本次实际收费的键(保存用)
  chargedPayrollMonths: string[];
  chargedServiceMonths: string[];
  billedTaxWeeks: string[]; // 本次新覆盖的工作周(周一 ISO)
  workWeeks: WeekRow[];
  feeRows: FeeRow[];
  inputs: ServiceFeeInputs;
}
