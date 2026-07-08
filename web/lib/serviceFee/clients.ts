import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { addDays, dayOfWeek, parseDate, toISO } from "./dateUtils";
import { getPool, normalizeName } from "./db";
import type { PriorCharges } from "./types";

export async function getClientById(id: number): Promise<ClientRow | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT id, display_name FROM clients WHERE id = ? LIMIT 1",
    [id],
  );
  if (!rows.length) return null;
  return { id: rows[0].id as number, displayName: rows[0].display_name as string };
}

export interface ClientListItem {
  id: number;
  displayName: string;
  recordCount: number;
  lastInputStart: string | null;
  lastInputEnd: string | null;
  lastActualEnd: string | null;
}

/** 全部客户 + 最近一次计算区间(用于客户选择器) */
export async function listClients(): Promise<ClientListItem[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT c.id, c.display_name,
        (SELECT COUNT(*) FROM fee_records WHERE client_id = c.id) AS record_count,
        (SELECT input_start_date FROM fee_records WHERE client_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_start,
        (SELECT input_end_date   FROM fee_records WHERE client_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_end,
        (SELECT actual_end_date  FROM fee_records WHERE client_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_actual
     FROM clients c
     ORDER BY c.display_name ASC`,
  );
  return rows.map((r) => ({
    id: r.id as number,
    displayName: r.display_name as string,
    recordCount: Number(r.record_count),
    lastInputStart: (r.last_start as string) ?? null,
    lastInputEnd: (r.last_end as string) ?? null,
    lastActualEnd: (r.last_actual as string) ?? null,
  }));
}

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
  // 锚点 = 该客户「全部」已收工作周里最早的那个周一(不排除当前区间,保证网格稳定)
  const [anchorRows] = await p.query<RowDataPacket[]>(
    "SELECT MIN(week_monday) AS anchor FROM billed_tax_weeks WHERE client_id = ?",
    [clientId],
  );
  return {
    payrollMonths: pm.map((r) => r.month as string),
    serviceMonths: sm.map((r) => r.month as string),
    taxWeeks: tw.map((r) => r.week_monday as string),
    taxAnchor: (anchorRows[0]?.anchor as string) ?? null,
  };
}

export interface PaymentFileMeta {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
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
  /** 是否已付(收款);paidAt = 标记已付的时间 */
  paid: boolean;
  paidAt: string | null;
  /** 付款凭证(标记已付时上传) */
  payments: PaymentFileMeta[];
}

export async function getHistory(clientId: number): Promise<HistoryRecord[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, input_start_date, input_end_date, actual_end_date,
            gross_wages, total_tax, total_payroll_fees, total_service_charge, grand_total,
            result_json, paid, paid_at, created_at
     FROM fee_records WHERE client_id = ? ORDER BY created_at DESC, id DESC`,
    [clientId],
  );
  // 该客户所有记录的付款凭证,一次查回按 record_id 分组
  const [payRows] = await p.query<RowDataPacket[]>(
    `SELECT pf.id, pf.record_id, pf.original_name, pf.mime_type, pf.size_bytes
     FROM fee_payment_file pf JOIN fee_records fr ON fr.id = pf.record_id
     WHERE fr.client_id = ? ORDER BY pf.id ASC`,
    [clientId],
  );
  const payByRecord = new Map<number, PaymentFileMeta[]>();
  for (const r of payRows) {
    const rid = r.record_id as number;
    const list = payByRecord.get(rid) ?? [];
    list.push({
      id: r.id as number,
      originalName: r.original_name as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
    });
    payByRecord.set(rid, list);
  }
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
      paid: Number(r.paid) === 1,
      paidAt: (r.paid_at as string) ?? null,
      payments: payByRecord.get(r.id as number) ?? [],
    };
  });
}

/** 建议下次开始日期 = 最近一次记录的 Actual End Date + 1 天(若落在周末则顺延到周一) */
export async function getSuggestedNextStart(clientId: number): Promise<string | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT actual_end_date FROM fee_records WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [clientId],
  );
  if (!rows.length) return null;
  let ts = addDays(parseDate(rows[0].actual_end_date as string), 1);
  while (dayOfWeek(ts) === 0 || dayOfWeek(ts) === 6) ts = addDays(ts, 1);
  return toISO(ts);
}
