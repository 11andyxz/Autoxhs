import { NextResponse, type NextRequest } from "next/server";

import {
  getClientById,
  getClientByName,
  getHistory,
  getPriorCharges,
  getSuggestedNextStart,
} from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY = { payrollMonths: [], serviceMonths: [], taxWeeks: [], taxAnchor: null };

export async function POST(req: NextRequest) {
  let body: { clientId?: number; name?: string; inputStartDate?: string; inputEndDate?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!body.clientId && !name) {
    return NextResponse.json({ success: false, error: "请提供客户。" }, { status: 400 });
  }

  try {
    await ensureSchema();
    const client = body.clientId
      ? await getClientById(body.clientId)
      : await getClientByName(name);
    if (!client) {
      return NextResponse.json({
        success: true,
        exists: false,
        priorCharges: EMPTY,
        suggestedNextStartDate: null,
        history: [],
      });
    }
    const [priorCharges, history, suggestedNextStartDate] = await Promise.all([
      getPriorCharges(client.id, body.inputStartDate, body.inputEndDate),
      getHistory(client.id),
      getSuggestedNextStart(client.id),
    ]);
    return NextResponse.json({
      success: true,
      exists: true,
      clientId: client.id,
      displayName: client.displayName,
      actualTaxPaid: client.actualTaxPaid,
      priorCharges,
      suggestedNextStartDate,
      history,
    });
  } catch (err) {
    console.error("[clients/lookup] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "查询客户失败,请稍后重试。" }, { status: 500 });
  }
}
