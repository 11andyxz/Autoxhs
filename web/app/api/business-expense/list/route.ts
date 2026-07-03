import { NextResponse } from "next/server";

import { ensureExpenseSchema, getExpenseSummary, listExpenses } from "@/lib/expense/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 全部花费 + 汇总统计。 */
export async function GET() {
  try {
    await ensureExpenseSchema();
    const [expenses, summary] = await Promise.all([listExpenses(), getExpenseSummary()]);
    return NextResponse.json({ success: true, expenses, summary });
  } catch (err) {
    console.error("[expense/list] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取记账本失败。" }, { status: 500 });
  }
}
