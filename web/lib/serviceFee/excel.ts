import ExcelJS from "exceljs";

import { calculateServiceFee, round2 } from "./calc";
import type { ServiceFeeInputs } from "./types";

const MONEY_FMT = '"$"#,##0.00';
const DATE_FMT = "mm/dd/yyyy";
const ACCENT = "FF0B6E4F";
const ACCENT_BG = "FFE7F6EF";
const HEADER_BG = "FF334155";

function xlDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d); // 本地午夜,避免时区 -1 天
}

/** 表头加粗+底色、首行冻结、开启筛选、自动列宽、金额/日期格式 */
function finishDataSheet(
  ws: ExcelJS.Worksheet,
  headerLen: number,
  moneyCols: number[],
  dateCols: number[],
) {
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    moneyCols.forEach((c) => (row.getCell(c).numFmt = MONEY_FMT));
    dateCols.forEach((c) => (row.getCell(c).numFmt = DATE_FMT));
  });
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
  headerRow.alignment = { vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headerLen } };
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const len = v == null ? 0 : v instanceof Date ? 10 : String(v).length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 28);
  });
}

/**
 * 重新计算并生成工作簿(与页面共用同一 calc,数字完全一致)。
 *  Sheet1 Summary / Sheet2 Work Hours(按工作周)/ Sheet3 Fee Breakdown
 */
export async function buildServiceFeeWorkbook(
  inputs: ServiceFeeInputs,
  generatedAt: string,
): Promise<Buffer> {
  const r = calculateServiceFee(inputs);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Service Fee Calculator";

  // ---------------- Sheet 1: Summary ----------------
  const s = wb.addWorksheet("Summary");
  s.columns = [{ width: 36 }, { width: 30 }];
  s.mergeCells("A1:B1");
  s.getCell("A1").value = "Service Fee Calculation — Summary";
  s.getCell("A1").font = { bold: true, size: 14 };
  s.addRow([]);

  const methodLabel = inputs.prorateServiceCharge
    ? "Prorated by calendar days"
    : "Per involved month (full)";
  const assignLabel =
    inputs.assignPayrollFeeBy === "payDate"
      ? `Pay Date (period end + ${inputs.payDateOffsetDays} days)`
      : "Payroll Period End Date";

  type Kind = "money" | "date" | "text" | "num";
  const summaryRows: Array<[string, string | number, Kind]> = [
    ["Original Selected Start Date", inputs.startDate, "date"],
    ["Original Selected End Date", inputs.endDate, "date"],
    ["Payroll Cycle Start Date", inputs.payrollCycleStartDate, "date"],
    ["Weekly Work Hours", inputs.weeklyWorkHours, "num"],
    ["Daily Work Hours", r.dailyWorkHours, "num"],
    ["Hourly Wage", inputs.hourlyWage, "money"],
    ["Tax Withheld Per Payroll", inputs.taxWithheldPerPayroll, "money"],
    ["First Payroll Fee", inputs.firstPayrollFee, "money"],
    ["Second Payroll Fee", inputs.secondPayrollFee, "money"],
    ["Monthly Service Charge", inputs.monthlyServiceCharge, "money"],
    ["Service Charge Calculation Method", methodLabel, "text"],
    ["Assign Payroll Fee By", assignLabel, "text"],
    ["Total Calendar Days", r.totalCalendarDays, "num"],
    ["Total Working Days (Actual)", r.totalWorkingDays, "num"],
    ["Total Adjusted Working Days", r.totalAdjustedWorkingDays, "num"],
    ["Work Week Count", r.workWeekCount, "num"],
    ["Total Work Hours", r.totalWorkHours, "num"],
    ["Gross Wages", r.grossWages, "money"],
    ["Total Tax Withheld", r.totalTaxWithheld, "money"],
    ["Total Payroll Fees", r.totalPayrollFees, "money"],
    ["Total Service Charge", r.totalServiceCharge, "money"],
    ["Grand Total", r.grandTotal, "money"],
    ["Generated At", generatedAt, "text"],
  ];
  for (const [label, value, kind] of summaryRows) {
    const row = s.addRow([label, kind === "date" ? xlDate(value as string) : value]);
    row.getCell(1).font = { bold: true };
    const vc = row.getCell(2);
    if (kind === "money") vc.numFmt = MONEY_FMT;
    else if (kind === "date") vc.numFmt = DATE_FMT;
    if (label === "Grand Total") {
      row.getCell(1).font = { bold: true, size: 12 };
      vc.font = { bold: true, size: 12, color: { argb: ACCENT } };
      vc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
    }
  }
  s.columns.forEach((col) => {
    let max = 12;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const len = v == null ? 0 : v instanceof Date ? 10 : String(v).length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 44);
  });
  s.views = [{ state: "frozen", ySplit: 1 }];

  // ---------------- Sheet 2: Work Hours (Weekly) ----------------
  const w = wb.addWorksheet("Work Hours (Weekly)");
  const wHeaders = [
    "Week No", "Original Selected Start Date", "Original Selected End Date",
    "Work Week Start Date", "Work Week End Date", "Covered Start Date", "Covered End Date",
    "Actual Working Days", "Adjusted Working Days", "Weekly Work Hours", "Work Hours",
    "Hourly Wage", "Gross Wages", "Work Hours Adjustment Type",
  ];
  w.addRow(wHeaders);
  for (const row of r.workWeeks) {
    w.addRow([
      row.index, xlDate(inputs.startDate), xlDate(inputs.endDate),
      xlDate(row.workWeekStartISO), xlDate(row.workWeekEndISO),
      xlDate(row.coveredStartISO), xlDate(row.coveredEndISO),
      row.actualWorkingDays, row.adjustedWorkingDays, row.weeklyWorkHours, row.workHours,
      row.hourlyWage, row.grossWages, row.adjustmentType,
    ]);
  }
  const wTotal = w.addRow([
    "Total", "", "", "", "", "", "",
    "", r.totalAdjustedWorkingDays, "", r.totalWorkHours, "", r.grossWages, "",
  ]);
  wTotal.font = { bold: true };
  wTotal.getCell(13).numFmt = MONEY_FMT;
  wTotal.getCell(13).font = { bold: true, color: { argb: ACCENT } };
  wTotal.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
  finishDataSheet(w, wHeaders.length, [12, 13], [2, 3, 4, 5, 6, 7]);

  // ---------------- Sheet 3: Fee Breakdown ----------------
  const f = wb.addWorksheet("Fee Breakdown");
  const fHeaders = [
    "Payroll Number", "Payroll Period Start", "Payroll Period End", "Payroll Month",
    "Payroll Sequence in Month", "Covered Start Date", "Covered End Date", "Calendar Days Covered",
    "Tax Withheld", "Payroll Fee Type", "Payroll Fee", "Service Charge", "Subtotal",
  ];
  f.addRow(fHeaders);
  for (const row of r.feeRows) {
    f.addRow([
      row.payrollNumber, xlDate(row.periodStartISO), xlDate(row.periodEndISO), row.payrollMonth,
      row.sequenceInMonth, xlDate(row.coveredStartISO), xlDate(row.coveredEndISO), row.calendarDaysCovered,
      row.taxWithheld, row.payrollFeeType, row.payrollFee, row.serviceCharge, row.subtotal,
    ]);
  }
  const feeTotal = round2(r.totalTaxWithheld + r.totalPayrollFees + r.totalServiceCharge);
  const fTotal = f.addRow([
    "Total", "", "", "", "", "", "", "",
    r.totalTaxWithheld, "", r.totalPayrollFees, r.totalServiceCharge, feeTotal,
  ]);
  fTotal.font = { bold: true };
  fTotal.getCell(13).font = { bold: true, color: { argb: ACCENT } };
  fTotal.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
  finishDataSheet(f, fHeaders.length, [9, 11, 12, 13], [2, 3, 6, 7]);

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
