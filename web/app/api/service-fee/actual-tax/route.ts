import { NextResponse, type NextRequest } from "next/server";

import { round2 } from "@/lib/serviceFee/calc";
import { getClientById, setActualTaxPaid } from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 保存客户累计「实际 tax」(税务余额的减数)。
 * 税务余额 = 累计 Tax Withheld(该客户全部已保存记录合计) − 实际 tax。
 * 实际 tax 存在 clients.actual_tax_paid,长期跟踪、刷新后仍在。
 */
export async function POST(req: NextRequest) {
  let body: { clientId?: number; actualTax?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  if (!body.clientId) {
    return NextResponse.json({ success: false, error: "缺少客户。" }, { status: 400 });
  }
  const amount = round2(Number(body.actualTax));
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ success: false, error: "实际 tax 必须是不小于 0 的数字。" }, { status: 400 });
  }

  try {
    await ensureSchema();
    const client = await getClientById(body.clientId);
    if (!client) {
      return NextResponse.json({ success: false, error: "客户不存在。" }, { status: 400 });
    }
    await setActualTaxPaid(client.id, amount);
    return NextResponse.json({ success: true, actualTaxPaid: amount });
  } catch (err) {
    console.error("[service-fee/actual-tax] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "保存失败,请稍后重试。" }, { status: 500 });
  }
}
