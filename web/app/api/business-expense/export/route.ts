import { NextResponse } from "next/server";

import { buildExpenseWorkbook } from "@/lib/expense/excel";
import { ensureExpenseSchema, getBusinessTotals, getExpenseSummary, listExpenses } from "@/lib/expense/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导出整本记账本为 Excel(明细 + 按 business + 按类别 + 按月)。始终导出全部 business。 */
export async function GET() {
  try {
    await ensureExpenseSchema();
    const [expenses, summary, businessTotals] = await Promise.all([
      listExpenses(),
      getExpenseSummary(),
      getBusinessTotals(),
    ]);
    const generatedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    const buf = await buildExpenseWorkbook(expenses, summary, businessTotals, generatedAt);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `Business_Ledger_${stamp}.xlsx`;
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[expense/export] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "导出失败,请稍后重试。" }, { status: 500 });
  }
}
