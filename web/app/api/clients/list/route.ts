import { NextResponse } from "next/server";

import { listClients } from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    const clients = await listClients();
    return NextResponse.json({ success: true, clients });
  } catch (err) {
    console.error("[clients/list] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取客户列表失败。" }, { status: 500 });
  }
}
