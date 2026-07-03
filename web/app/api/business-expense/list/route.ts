import { NextResponse, type NextRequest } from "next/server";

import { ensureExpenseSchema, getExpenseSummary, listBusinesses, listExpenses } from "@/lib/expense/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** business 清单 + 收支明细 + 汇总。可选 ?businessId=N 按 business 过滤(明细与汇总),清单始终为全部。 */
export async function GET(req: NextRequest) {
  try {
    await ensureExpenseSchema();
    const raw = req.nextUrl.searchParams.get("businessId");
    const parsed = raw ? Number(raw) : NaN;
    const businessId = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;

    const [businesses, expenses, summary] = await Promise.all([
      listBusinesses(),
      listExpenses(businessId),
      getExpenseSummary(businessId),
    ]);
    return NextResponse.json({ success: true, businesses, expenses, summary, businessId: businessId ?? null });
  } catch (err) {
    console.error("[expense/list] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取记账本失败。" }, { status: 500 });
  }
}
