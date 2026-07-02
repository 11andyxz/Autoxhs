import { parseDate } from "./dateUtils";
import type { ServiceFeeInputs } from "./types";

/** 返回错误信息列表(空数组表示通过)。客户端解析后调用,服务端导出前也调用。 */
export function validateInputs(i: ServiceFeeInputs): string[] {
  const e: string[] = [];
  if (!i.startDate) e.push("请选择 Start Date。");
  if (!i.endDate) e.push("请选择 End Date。");
  if (i.startDate && i.endDate && parseDate(i.endDate) < parseDate(i.startDate)) {
    e.push("End Date 不能早于 Start Date。");
  }
  if (!(i.weeklyWorkHours >= 0)) e.push("Weekly Work Hours 不能小于 0,请填写有效数字。");
  if (!(i.hourlyWage >= 0)) e.push("请填写 Hourly Wage(时薪,必填且不能小于 0)。");
  if (!(i.taxWithheldPerPayroll >= 0)) e.push("Tax Withheld 不能小于 0。");
  if (!(i.monthlyPayrollFee >= 0)) e.push("Monthly Payroll Fee 不能小于 0。");
  if (!(i.monthlyServiceCharge >= 0)) e.push("Monthly Service Charge 不能小于 0。");
  if (i.serviceChargeAnchorDate && Number.isNaN(parseDate(i.serviceChargeAnchorDate))) {
    e.push("Service Fee 起算日无效。");
  }
  return e;
}
