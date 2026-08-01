import { NextResponse, type NextRequest } from "next/server";

import { MAX_BATCH_ROWS } from "@/lib/expense/batch";
import { businessExists, ensureExpenseSchema, insertExpense } from "@/lib/expense/repo";
import { parseBusinessId, trimExpense, validateExpense, type ExpenseInput } from "@/lib/expense/validate";
import { getPool } from "@/lib/serviceFee/db";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JSON 体上限:200 行 × 每行几百字节,1MB 绰绰有余(纯文本,不含文件)。 */
const MAX_BODY_BYTES = 1024 * 1024;

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 批量落库:把复核过的多笔收支一次性写进同一个 business。
 * 全部成功或全部回滚——半截入账比不入账更难收拾。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return bad("提交内容过大,请分批保存。", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const payload = (body ?? {}) as { businessId?: unknown; rows?: unknown };

  // 前端可能传数字也可能传字符串,统一成字符串再校验
  const businessId = parseBusinessId(String(payload.businessId ?? ""));
  if (businessId === null) return bad("请选择所属 business。");

  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return bad("没有要保存的记录。");
  }
  if (payload.rows.length > MAX_BATCH_ROWS) {
    return bad(`一次最多保存 ${MAX_BATCH_ROWS} 笔,请分批。`);
  }

  const expenses: ExpenseInput[] = [];
  for (let i = 0; i < payload.rows.length; i += 1) {
    const r = (payload.rows[i] ?? {}) as Record<string, unknown>;
    const e = trimExpense({
      businessId: String(businessId),
      type: str(r.type),
      spentOn: str(r.spentOn),
      amount: str(r.amount),
      category: str(r.category),
      vendor: str(r.vendor),
      paymentMethod: str(r.paymentMethod),
      note: str(r.note),
    });
    const errs = validateExpense(e);
    if (errs.length) return bad(`第 ${i + 1} 笔:${errs[0]}`);
    expenses.push(e);
  }

  await ensureExpenseSchema();
  if (!(await businessExists(businessId))) {
    return bad("所选 business 不存在,请重新选择。");
  }

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    for (const e of expenses) await insertExpense(conn, e);
    await conn.commit();
    return NextResponse.json({ success: true, savedCount: expenses.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_NO_REFERENCED_ROW_2" || code === "ER_NO_REFERENCED_ROW") {
      return bad("所选 business 不存在,请重新选择。");
    }
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/save-batch] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/save-batch] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}
