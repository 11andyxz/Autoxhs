import { NextResponse, type NextRequest } from "next/server";

import { ensureSchema, getPool } from "@/lib/serviceFee/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { recordId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const recordId = Number(body.recordId);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return NextResponse.json({ success: false, error: "缺少有效的 recordId。" }, { status: 400 });
  }

  try {
    await ensureSchema();
    // billed_payroll_months / billed_service_months / billed_tax_weeks 均为 ON DELETE CASCADE,
    // 删除 fee_record 会自动清掉其已收键,去重历史随之恢复。
    const [res] = await getPool().query("DELETE FROM fee_records WHERE id = ?", [recordId]);
    const affected = (res as { affectedRows: number }).affectedRows;
    if (!affected) {
      return NextResponse.json({ success: false, error: "记录不存在或已删除。" }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted: affected });
  } catch (err) {
    console.error("[service-fee/delete] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "删除失败,请稍后重试。" }, { status: 500 });
  }
}
