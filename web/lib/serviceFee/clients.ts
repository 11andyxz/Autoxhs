import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { getPool, normalizeName } from "./db";
import type { PriorCharges } from "./types";

export interface ClientRow {
  id: number;
  displayName: string;
}

export async function getClientByName(name: string): Promise<ClientRow | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT id, display_name FROM clients WHERE normalized_name = ? LIMIT 1",
    [normalizeName(name)],
  );
  if (!rows.length) return null;
  return { id: rows[0].id as number, displayName: rows[0].display_name as string };
}

/** 事务内:按归一化名查或建客户,返回 id + 展示名 */
export async function getOrCreateClient(
  conn: PoolConnection,
  name: string,
): Promise<ClientRow> {
  const normalized = normalizeName(name);
  const display = name.trim();
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, display_name FROM clients WHERE normalized_name = ? LIMIT 1",
    [normalized],
  );
  if (rows.length) return { id: rows[0].id as number, displayName: rows[0].display_name as string };
  const [res] = await conn.query(
    "INSERT INTO clients (normalized_name, display_name) VALUES (?, ?)",
    [normalized, display],
  );
  return { id: (res as { insertId: number }).insertId, displayName: display };
}

/**
 * 该客户「已保存」的费用键(用于去重)。
 * excludeStart/excludeEnd:排除与当前计算区间完全相同的那条记录(便于重算/更新同一区间)。
 */
export async function getPriorCharges(
  clientId: number,
  excludeStart?: string,
  excludeEnd?: string,
): Promise<PriorCharges> {
  const p = getPool();
  const exclude = !!(excludeStart && excludeEnd);
  const notIn =
    " AND record_id NOT IN (SELECT id FROM fee_records WHERE client_id = ? AND input_start_date = ? AND input_end_date = ?)";
  const args = exclude ? [clientId, clientId, excludeStart, excludeEnd] : [clientId];

  const [pm] = await p.query<RowDataPacket[]>(
    `SELECT month FROM billed_payroll_months WHERE client_id = ?${exclude ? notIn : ""}`,
    args,
  );
  const [sm] = await p.query<RowDataPacket[]>(
    `SELECT month FROM billed_service_months WHERE client_id = ?${exclude ? notIn : ""}`,
    args,
  );
  const [tw] = await p.query<RowDataPacket[]>(
    `SELECT week_monday FROM billed_tax_weeks WHERE client_id = ?${exclude ? notIn : ""}`,
    args,
  );
  return {
    payrollMonths: pm.map((r) => r.month as string),
    serviceMonths: sm.map((r) => r.month as string),
    taxWeeks: tw.map((r) => r.week_monday as string),
  };
}

export interface HistoryRecord {
  id: number;
  inputStartDate: string;
  inputEndDate: string;
  actualEndDate: string;
  grossWages: number;
  totalTax: number;
  totalPayrollFees: number;
  totalServiceCharge: number;
  grandTotal: number;
  payrollFeeMonths: string[];
  createdAt: string;
  result: unknown; // 完整 CalculationResult 快照(供 View / 重新导出)
}

export async function getHistory(clientId: number): Promise<HistoryRecord[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, input_start_date, input_end_date, actual_end_date,
            gross_wages, total_tax, total_payroll_fees, total_service_charge, grand_total,
            result_json, created_at
     FROM fee_records WHERE client_id = ? ORDER BY created_at DESC, id DESC`,
    [clientId],
  );
  return rows.map((r) => {
    const result =
      typeof r.result_json === "string" ? JSON.parse(r.result_json) : r.result_json;
    return {
      id: r.id as number,
      inputStartDate: r.input_start_date as string,
      inputEndDate: r.input_end_date as string,
      actualEndDate: r.actual_end_date as string,
      grossWages: Number(r.gross_wages),
      totalTax: Number(r.total_tax),
      totalPayrollFees: Number(r.total_payroll_fees),
      totalServiceCharge: Number(r.total_service_charge),
      grandTotal: Number(r.grand_total),
      payrollFeeMonths: (result?.chargedPayrollMonths as string[]) ?? [],
      createdAt: r.created_at as string,
      result,
    };
  });
}

/** 最近一次保存记录的 Actual End Date(作为建议下次开始日期) */
export async function getSuggestedNextStart(clientId: number): Promise<string | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT actual_end_date FROM fee_records WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [clientId],
  );
  return rows.length ? (rows[0].actual_end_date as string) : null;
}
