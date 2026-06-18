export type AssignPayrollFeeBy = "periodEnd" | "payDate";

/** 计算器的全部输入(纯数据,UI 和导出共用) */
export interface ServiceFeeInputs {
  startDate: string; // 'YYYY-MM-DD'(用户原始选择)
  endDate: string; // 'YYYY-MM-DD'(用户原始选择)
  payrollCycleStartDate: string; // 'YYYY-MM-DD'
  weeklyWorkHours: number;
  hourlyWage: number;
  taxWithheldPerPayroll: number;
  firstPayrollFee: number;
  secondPayrollFee: number;
  monthlyServiceCharge: number;
  prorateServiceCharge: boolean;
  assignPayrollFeeBy: AssignPayrollFeeBy;
  payDateOffsetDays: number;
}

export type PayrollFeeType = "First" | "Second" | "None";

export type WorkHoursAdjustment =
  | "Start Week Minimum Hours"
  | "Full Work Week"
  | "End Week Extended"
  | "No Adjustment";

/** 工时行:一个自然工作周(周一–周日)。Work Hours 按整周补足 Weekly Work Hours。 */
export interface WeekRow {
  index: number;
  workWeekStart: string; // MM/DD/YYYY,显示用(首周= Start Date,不向前补;末周顺延至周日)
  workWeekEnd: string;
  workWeekStartISO: string;
  workWeekEndISO: string;
  coveredStart: string; // MM/DD/YYYY,本周与「原始选择区间」的交集
  coveredEnd: string;
  coveredStartISO: string;
  coveredEndISO: string;
  actualWorkingDays: number; // 落在原始选择区间内的实际 Mon–Fri 天数
  adjustedWorkingDays: number; // 计入的工作日(首周从 Start 起;中/末周补齐)
  weeklyWorkHours: number;
  workHours: number; // 恒等于 weeklyWorkHours
  hourlyWage: number;
  grossWages: number; // weeklyWorkHours × hourlyWage
  adjustmentType: WorkHoursAdjustment;
}

/** 费用行:一个 Payroll Period 在某自然月内的片段(费用逻辑不变,基于原始选择区间) */
export interface FeeRow {
  payrollNumber: number;
  periodStart: string;
  periodEnd: string;
  periodStartISO: string;
  periodEndISO: string;
  payrollMonth: string;
  sequenceInMonth: number;
  coveredStart: string;
  coveredEnd: string;
  coveredStartISO: string;
  coveredEndISO: string;
  calendarDaysCovered: number;
  taxWithheld: number;
  payrollFeeType: PayrollFeeType;
  payrollFee: number;
  serviceCharge: number;
  subtotal: number; // tax + payrollFee + serviceCharge
}

export interface CalculationResult {
  // 日期统计(基于原始选择区间)
  totalCalendarDays: number;
  totalWorkingDays: number; // 实际 Mon–Fri 天数
  totalWeekendDays: number;
  payrollPeriodCount: number;
  monthCount: number;
  // 工时
  weeklyWorkHours: number;
  dailyWorkHours: number; // 仅信息展示(weekly ÷ 5)
  workWeekCount: number;
  totalAdjustedWorkingDays: number;
  totalWorkHours: number;
  // 金额
  grossWages: number; // 来自工时周
  totalTaxWithheld: number;
  totalPayrollFees: number;
  totalServiceCharge: number;
  grandTotal: number;
  // 明细
  workWeeks: WeekRow[];
  feeRows: FeeRow[];
  inputs: ServiceFeeInputs;
}
