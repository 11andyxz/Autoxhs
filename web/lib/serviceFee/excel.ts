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
  return new Date(y, m - 1, d);
}

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
 *  Sheet1 Summary / Sheet2 Work Hours(含 Tax)/ Sheet3 Fee Breakdown(按月)
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
  s.columns = [{ width: 38 }, { width: 30 }];
  s.mergeCells("A1:B1");
  s.getCell("A1").value = "Service Fee Calculation — Summary";
  s.getCell("A1").font = { bold: true, size: 14 };
  s.addRow([]);

  type Kind = "money" | "date" | "text" | "num";
  const summaryRows: Array<[string, string | number, Kind]> = [
    ["Original Selected Start Date", inputs.startDate, "date"],
    ["Original Selected End Date", inputs.endDate, "date"],
    ["Weekly Work Hours", inputs.weeklyWorkHours, "num"],
    ["Daily Work Hours", r.dailyWorkHours, "num"],
    ["Hourly Wage", inputs.hourlyWage, "money"],
    ["Tax Withheld Per Biweekly (every 2 weeks)", inputs.taxWithheldPerPayroll, "money"],
    ["Monthly Payroll Fee", inputs.monthlyPayrollFee, "money"],
    ["Monthly Service Charge", inputs.monthlyServiceCharge, "money"],
    ["Service Charge Basis", "Monthly anniversary of Start Date", "text"],
    ["Total Calendar Days", r.totalCalendarDays, "num"],
    ["Total Working Days (Actual)", r.totalWorkingDays, "num"],
    ["Total Adjusted Working Days", r.totalAdjustedWorkingDays, "num"],
    ["Work Week Count", r.workWeekCount, "num"],
    ["Total Work Hours", r.totalWorkHours, "num"],
    ["Tax Charge Count (every 2 weeks)", r.taxChargeCount, "num"],
    ["Covered Month Count", r.monthCount, "num"],
    ["Service Charge Count", r.serviceChargeCount, "num"],
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
    "Hourly Wage", "Gross Wages", "Tax Withheld", "Work Hours Adjustment Type",
  ];
  w.addRow(wHeaders);
  for (const row of r.workWeeks) {
    w.addRow([
      row.index, xlDate(inputs.startDate), xlDate(inputs.endDate),
      xlDate(row.workWeekStartISO), xlDate(row.workWeekEndISO),
      xlDate(row.coveredStartISO), xlDate(row.coveredEndISO),
      row.actualWorkingDays, row.adjustedWorkingDays, row.weeklyWorkHours, row.workHours,
      row.hourlyWage, row.grossWages, row.taxWithheld, row.adjustmentType,
    ]);
  }
  const wTotal = w.addRow([
    "Total", "", "", "", "", "", "",
    "", r.totalAdjustedWorkingDays, "", r.totalWorkHours, "", r.grossWages, r.totalTaxWithheld, "",
  ]);
  wTotal.font = { bold: true };
  [13, 14].forEach((c) => (wTotal.getCell(c).numFmt = MONEY_FMT));
  wTotal.getCell(13).font = { bold: true, color: { argb: ACCENT } };
  wTotal.getCell(13).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
  finishDataSheet(w, wHeaders.length, [12, 13, 14], [2, 3, 4, 5, 6, 7]);

  // ---------------- Sheet 3: Fee Breakdown (by month) ----------------
  const f = wb.addWorksheet("Fee Breakdown");
  const fHeaders = [
    "Payroll Month", "Covered Start Date", "Covered End Date",
    "Monthly Payroll Fee", "Service Charge Date", "Service Charge", "Subtotal",
  ];
  f.addRow(fHeaders);
  for (const row of r.feeRows) {
    f.addRow([
      row.payrollMonth, xlDate(row.coveredStartISO), xlDate(row.coveredEndISO),
      row.payrollFee, row.serviceChargeDateISO ? xlDate(row.serviceChargeDateISO) : "",
      row.serviceCharge, row.subtotal,
    ]);
  }
  const feeTotal = round2(r.totalPayrollFees + r.totalServiceCharge);
  const fTotal = f.addRow([
    "Total", "", "", r.totalPayrollFees, "", r.totalServiceCharge, feeTotal,
  ]);
  fTotal.font = { bold: true };
  fTotal.getCell(7).font = { bold: true, color: { argb: ACCENT } };
  fTotal.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_BG } };
  finishDataSheet(f, fHeaders.length, [4, 6, 7], [2, 3, 5]);

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
