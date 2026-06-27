import { NextResponse } from "next/server";

import { ensureEmployeeSchema, listEmployees } from "@/lib/employee/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureEmployeeSchema();
    const employees = await listEmployees();
    return NextResponse.json({ success: true, employees });
  } catch (err) {
    console.error("[employee/list] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取雇员列表失败。" }, { status: 500 });
  }
}
