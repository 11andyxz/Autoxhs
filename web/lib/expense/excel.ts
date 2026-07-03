/**
 * 把花费记账本导出为 Excel(仅服务器端)。
 * Sheet1 明细 / Sheet2 按类别汇总 / Sheet3 按月汇总。样式沿用收费计算器导出的风格。
 */
import ExcelJS from "exceljs";

import type { ExpenseSummary, ExpenseWithFiles } from "./repo";

const MONEY_FMT = '"$"#,##0.00';
const DATE_FMT = "yyyy-mm-dd";
const HEADER_BG = "FF334155";

function xlDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function styleSheet(ws: ExcelJS.Worksheet, headerLen: number, moneyCols: number[], dateCols: number[]) {
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
    col.width = Math.min(max + 2, 40);
  });
}

/** 由花费列表 + 汇总生成工作簿。 */
export async function buildExpenseWorkbook(
  expenses: ExpenseWithFiles[],
  summary: ExpenseSummary,
  generatedAt: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Business Expense Ledger";

  // ---------------- Sheet 1: 明细 ----------------
  const detail = wb.addWorksheet("明细 Detail");
  detail.columns = [
    { header: "日期 Date", key: "date" },
    { header: "金额 Amount", key: "amount" },
    { header: "类别 Category", key: "category" },
    { header: "收款方 Vendor", key: "vendor" },
    { header: "付款方式 Payment", key: "payment" },
    { header: "备注 Note", key: "note" },
    { header: "凭证 Receipts", key: "receipts" },
    { header: "记录于 Created At", key: "createdAt" },
  ];
  for (const e of expenses) {
    detail.addRow({
      date: xlDate(e.spentOn),
      amount: e.amount,
      category: e.category,
      vendor: e.vendor,
      payment: e.paymentMethod,
      note: e.note,
      receipts: e.files.map((f) => f.originalName).join("; "),
      createdAt: e.createdAt,
    });
  }
  // 合计行
  const totalRow = detail.addRow({ date: undefined, amount: summary.grandTotal, category: "合计 Total" });
  totalRow.font = { bold: true };
  styleSheet(detail, 8, [2], [1]);

  // ---------------- Sheet 2: 按类别 ----------------
  const byCat = wb.addWorksheet("按类别 By Category");
  byCat.columns = [
    { header: "类别 Category", key: "category" },
    { header: "笔数 Count", key: "count" },
    { header: "合计 Total", key: "total" },
  ];
  for (const c of summary.byCategory) {
    byCat.addRow({ category: c.category, count: c.count, total: c.total });
  }
  styleSheet(byCat, 3, [3], []);

  // ---------------- Sheet 3: 按月 ----------------
  const byMonth = wb.addWorksheet("按月 By Month");
  byMonth.columns = [
    { header: "月份 Month", key: "month" },
    { header: "笔数 Count", key: "count" },
    { header: "合计 Total", key: "total" },
  ];
  for (const m of summary.byMonth) {
    byMonth.addRow({ month: m.month, count: m.count, total: m.total });
  }
  styleSheet(byMonth, 3, [3], []);

  // 页脚说明
  const foot = byMonth.addRow({ month: `导出于 ${generatedAt}` });
  foot.font = { italic: true, color: { argb: "FF94A3B8" } };

  const arrayBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}
