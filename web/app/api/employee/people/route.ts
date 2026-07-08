import { NextResponse } from "next/server";

import { ensureEmployeeSchema, listEmployees, type EmployeeWithFiles } from "@/lib/employee/repo";
import { nameMergeKey, splitFullName } from "@/lib/employee/validate";
import { getHistory, listClients, type HistoryRecord, type PaymentFileMeta } from "@/lib/serviceFee/clients";
import { ensureSchema } from "@/lib/serviceFee/db";
import { listWorkEmailsByEmployee, type WorkEmailLogItem } from "@/lib/workEmail/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeeRecord {
  id: number;
  inputStartDate: string;
  inputEndDate: string;
  actualEndDate: string;
  payrollMonths: string[];
  payrollFee: number;
  serviceFee: number;
  total: number;
  createdAt: string;
  result: unknown;
  paid: boolean;
  paidAt: string | null;
  payments: PaymentFileMeta[];
}

interface Person {
  displayName: string;
  firstName: string;
  lastName: string;
  employee: EmployeeWithFiles | null;
  feeClientName: string | null;
  feeHistory: FeeRecord[];
  workEmails: WorkEmailLogItem[];
}

function mapFee(h: HistoryRecord): FeeRecord {
  return {
    id: h.id,
    inputStartDate: h.inputStartDate,
    inputEndDate: h.inputEndDate,
    actualEndDate: h.actualEndDate,
    payrollMonths: h.payrollFeeMonths,
    payrollFee: h.totalPayrollFees,
    serviceFee: h.totalServiceCharge,
    total: h.grandTotal,
    createdAt: h.createdAt,
    result: h.result,
    paid: h.paid,
    paidAt: h.paidAt,
    payments: h.payments,
  };
}

/**
 * 统一人员列表 = 雇员 ∪ 收费客户,按归一化全名归并。
 * - 雇员且姓名匹配到收费客户:含雇员资料 + 该客户收费历史。
 * - 仅雇员:含雇员资料,无收费历史。
 * - 仅收费客户:无雇员资料(employee=null),按姓名拆出 first/last 供补录,含收费历史。
 */
export async function GET() {
  try {
    await Promise.all([ensureEmployeeSchema(), ensureSchema()]);
    const [employees, clients, workEmailsByEmp] = await Promise.all([
      listEmployees(),
      listClients(),
      listWorkEmailsByEmployee(),
    ]);
    // 单个客户历史解析失败(如 result_json 损坏)只降级为空,不连累整个列表
    const histories = await Promise.all(clients.map((c) => getHistory(c.id).catch(() => [])));

    const clientByKey = new Map<string, { displayName: string; history: FeeRecord[] }>();
    clients.forEach((c, i) => {
      const k = nameMergeKey(c.displayName);
      const mapped = histories[i].map(mapFee);
      const existing = clientByKey.get(k);
      // 两个客户名仅内部空格不同会折叠成同一键:合并历史而非覆盖,避免丢记录
      if (existing) existing.history.push(...mapped);
      else clientByKey.set(k, { displayName: c.displayName, history: mapped });
    });

    const used = new Set<string>();
    const people: Person[] = [];

    for (const emp of employees) {
      const k = nameMergeKey(`${emp.legalFirstName} ${emp.legalLastName}`);
      const match = clientByKey.get(k);
      if (match) used.add(k);
      people.push({
        displayName: `${emp.legalFirstName} ${emp.legalLastName}`.trim(),
        firstName: emp.legalFirstName,
        lastName: emp.legalLastName,
        employee: emp,
        feeClientName: match?.displayName ?? null,
        feeHistory: match?.history ?? [],
        workEmails: workEmailsByEmp.get(emp.id) ?? [],
      });
    }

    for (const [k, c] of clientByKey) {
      if (used.has(k)) continue;
      const { firstName, lastName } = splitFullName(c.displayName);
      people.push({
        displayName: c.displayName,
        firstName,
        lastName,
        employee: null,
        feeClientName: c.displayName,
        feeHistory: c.history,
        workEmails: [],
      });
    }

    return NextResponse.json({ success: true, people });
  } catch (err) {
    console.error("[employee/people] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "读取人员列表失败。" }, { status: 500 });
  }
}
