import { NextResponse, type NextRequest } from "next/server";

import { getClientById } from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";
import { getPayrollTaxForClient } from "@/lib/serviceFee/payrollTaxSource";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 从该客户已上传的 payroll summary PDF 里自动读出「实际 tax」
 * (= 各份 Employer Taxes 合计之和)。只读,不写库。
 *
 * 入参(二选一):?clientId=1 或 ?name=Bin%20Meng。
 * 客户与雇员按「归一化全名」归并(同 /api/employee/people)。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) {
    return NextResponse.json({ success: false, error: "当前请求较多,请稍后再试。" }, { status: 429 });
  }

  const sp = req.nextUrl.searchParams;
  const clientIdRaw = sp.get("clientId");
  const nameRaw = (sp.get("name") ?? "").trim().slice(0, 200);
  const clientId = clientIdRaw != null && /^\d+$/.test(clientIdRaw) ? Number(clientIdRaw) : null;
  if (clientId == null && !nameRaw) {
    return NextResponse.json({ success: false, error: "缺少客户。" }, { status: 400 });
  }

  try {
    let name = nameRaw;
    if (clientId != null) {
      await ensureSchema();
      const client = await getClientById(clientId);
      if (!client) {
        return NextResponse.json({ success: false, error: "客户不存在。" }, { status: 404 });
      }
      name = client.displayName;
    }
    const summary = await getPayrollTaxForClient(name);
    return NextResponse.json({ success: true, clientName: name, ...summary });
  } catch (err) {
    console.error("[service-fee/payroll-tax] 失败", { name: (err as Error)?.name });
    return NextResponse.json(
      { success: false, error: "读取 payroll summary 失败,请稍后重试。" },
      { status: 500 },
    );
  }
}
