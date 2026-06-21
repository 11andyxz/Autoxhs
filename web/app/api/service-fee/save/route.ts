import { NextResponse, type NextRequest } from "next/server";
import type { RowDataPacket } from "mysql2/promise";

import { calculateServiceFee } from "@/lib/serviceFee/calc";
import { getClientById, getOrCreateClient, getPriorCharges } from "@/lib/serviceFee/clients";
import { ensureSchema, getPool } from "@/lib/serviceFee/db";
import type { ServiceFeeInputs } from "@/lib/serviceFee/types";
import { validateInputs } from "@/lib/serviceFee/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { clientId?: number; name?: string; inputs?: ServiceFeeInputs; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!body.clientId && !name) {
    return NextResponse.json({ success: false, error: "请先填写客户姓名。" }, { status: 400 });
  }
  if (!body.inputs) {
    return NextResponse.json({ success: false, error: "缺少计算输入。" }, { status: 400 });
  }
  const errors = validateInputs(body.inputs);
  if (errors.length) {
    return NextResponse.json({ success: false, error: errors[0] }, { status: 400 });
  }

  const inputs = body.inputs;
  const force = !!body.force;

  await ensureSchema();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let client;
    if (body.clientId) {
      const existing = await getClientById(body.clientId);
      if (!existing) {
        await conn.rollback();
        return NextResponse.json({ success: false, error: "客户不存在。" }, { status: 400 });
      }
      client = existing;
    } else {
      client = await getOrCreateClient(conn, name);
    }

    // 去重键:排除「与本区间完全相同」的旧记录,保证重算/更新同区间时本区间费用完整计入
    const prior = await getPriorCharges(client.id, inputs.startDate, inputs.endDate);
    const result = calculateServiceFee(inputs, prior);

    const startISO = result.inputStartDateISO;
    const endISO = result.inputEndDateISO;
    const actualISO = result.actualEndDateISO;

    const [dupRows] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM fee_records WHERE client_id=? AND input_start_date=? AND input_end_date=? AND actual_end_date=? LIMIT 1",
      [client.id, startISO, endISO, actualISO],
    );
    if (dupRows.length && !force) {
      await conn.rollback();
      return NextResponse.json({ success: false, duplicate: true });
    }
    if (dupRows.length && force) {
      // 删除旧记录(级联清掉它的 billed_* 键),再重新写入
      await conn.query("DELETE FROM fee_records WHERE id=?", [dupRows[0].id]);
    }

    const [ins] = await conn.query(
      `INSERT INTO fee_records
        (client_id, input_start_date, input_end_date, actual_end_date,
         weekly_work_hours, hourly_wage, tax_per_payroll, monthly_payroll_fee, monthly_service_charge,
         gross_wages, total_tax, total_payroll_fees, total_service_charge, grand_total, result_json)
       VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?)`,
      [
        client.id, startISO, endISO, actualISO,
        inputs.weeklyWorkHours, inputs.hourlyWage, inputs.taxWithheldPerPayroll,
        inputs.monthlyPayrollFee, inputs.monthlyServiceCharge,
        result.grossWages, result.totalTaxWithheld, result.totalPayrollFees,
        result.totalServiceCharge, result.grandTotal, JSON.stringify(result),
      ],
    );
    const recordId = (ins as { insertId: number }).insertId;

    for (const month of result.chargedPayrollMonths) {
      await conn.query(
        "INSERT INTO billed_payroll_months (client_id, record_id, month) VALUES (?,?,?)",
        [client.id, recordId, month],
      );
    }
    for (const month of result.chargedServiceMonths) {
      await conn.query(
        "INSERT INTO billed_service_months (client_id, record_id, month) VALUES (?,?,?)",
        [client.id, recordId, month],
      );
    }
    for (const week of result.billedTaxWeeks) {
      await conn.query(
        "INSERT INTO billed_tax_weeks (client_id, record_id, week_monday) VALUES (?,?,?)",
        [client.id, recordId, week],
      );
    }

    await conn.commit();
    return NextResponse.json({
      success: true,
      updated: dupRows.length > 0,
      recordId,
      grandTotal: result.grandTotal,
    });
  } catch (err) {
    await conn.rollback();
    console.error("[service-fee/save] 失败", { name: (err as Error)?.name, msg: (err as Error)?.message });
    return NextResponse.json({ success: false, error: "保存失败,请稍后重试。" }, { status: 500 });
  } finally {
    conn.release();
  }
}
