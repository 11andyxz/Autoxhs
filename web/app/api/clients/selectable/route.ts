import { NextResponse } from "next/server";

import { ensureEmployeeSchema, listEmployees } from "@/lib/employee/repo";
import { nameMergeKey } from "@/lib/employee/validate";
import { listClients } from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SelectableClient = {
  id: number | null; // null = 仅雇员(尚无收费客户记录)
  displayName: string;
  recordCount: number;
  lastInputStart: string | null;
  lastInputEnd: string | null;
  lastActualEnd: string | null;
  source: "client" | "employee";
};

/**
 * 收费页客户下拉用的可选列表 = 收费客户 ∪ 未匹配雇员(按归一化全名)。
 * 雇员项 id 为 null,选中后按「新客户」处理,保存时由 getOrCreateClient 按名建客户。
 * 不改 /api/clients/list 语义。
 */
export async function GET() {
  try {
    await Promise.all([ensureSchema(), ensureEmployeeSchema()]);
    const [clients, employees] = await Promise.all([listClients(), listEmployees()]);

    const out: SelectableClient[] = clients.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      recordCount: c.recordCount,
      lastInputStart: c.lastInputStart,
      lastInputEnd: c.lastInputEnd,
      lastActualEnd: c.lastActualEnd,
      source: "client",
    }));

    const seen = new Set(clients.map((c) => nameMergeKey(c.displayName)));
    for (const e of employees) {
      const name = `${e.legalFirstName} ${e.legalLastName}`.trim();
      const key = nameMergeKey(name);
      if (!name || seen.has(key)) continue; // 已是收费客户(或重名雇员)则不重复列
      seen.add(key);
      out.push({
        id: null,
        displayName: name,
        recordCount: 0,
        lastInputStart: null,
        lastInputEnd: null,
        lastActualEnd: null,
        source: "employee",
      });
    }

    return NextResponse.json({ success: true, clients: out });
  } catch (err) {
    console.error("[clients/selectable] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取列表失败。" }, { status: 500 });
  }
}
