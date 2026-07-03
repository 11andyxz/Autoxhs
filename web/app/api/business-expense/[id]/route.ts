import { NextResponse, type NextRequest } from "next/server";

import {
  MAX_TOTAL_BYTES,
  parseExpenseForm,
  PayloadTooLargeError,
  persistExpenseFiles,
  readCappedFormData,
} from "@/lib/expense/form";
import {
  businessExists,
  deleteExpenseById,
  ensureExpenseSchema,
  expenseExists,
  updateExpenseById,
} from "@/lib/expense/repo";
import { removeExpenseFilesByRelativePaths, removeFileSafe } from "@/lib/expense/storage";
import { getPool } from "@/lib/serviceFee/db";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 按 id 更新花费基本字段,并可追加凭证。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const { id } = await params;
  const expenseId = parseId(id);
  if (expenseId === null) return bad("无效的记录 ID。");

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return bad("上传内容过大,请减少凭证数量或体积。", 413);
  }
  let form: FormData;
  try {
    form = await readCappedFormData(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return bad("上传内容过大,请减少凭证数量或体积。", 413);
    }
    return bad("请求格式有误。");
  }

  const parsed = parseExpenseForm(form);
  if (!parsed.ok) return bad(parsed.error);

  await ensureExpenseSchema();
  if (!(await businessExists(Number(parsed.expense.businessId)))) {
    return bad("所选 business 不存在,请重新选择。");
  }
  const conn = await getPool().getConnection();
  const writtenPaths: string[] = [];
  try {
    await conn.beginTransaction();
    if (!(await expenseExists(conn, expenseId))) {
      await conn.rollback();
      return bad("记录不存在。", 404);
    }
    await updateExpenseById(conn, expenseId, parsed.expense);
    await persistExpenseFiles(conn, expenseId, parsed.files, writtenPaths);
    await conn.commit();
    return NextResponse.json({ success: true, expenseId, fileCount: parsed.files.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => removeFileSafe(p)));
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_NO_REFERENCED_ROW_2" || code === "ER_NO_REFERENCED_ROW") {
      return bad("所选 business 不存在,请重新选择。");
    }
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/update] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/update] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}

/** 删除一条花费(连同其凭证行 CASCADE + 磁盘文件)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const { id } = await params;
  const expenseId = parseId(id);
  if (expenseId === null) return bad("无效的记录 ID。");

  try {
    await ensureExpenseSchema();
    const { deleted, relativePaths } = await deleteExpenseById(expenseId);
    if (!deleted) return bad("记录不存在或已删除。", 404);
    // DB 行已删,再尽力清理磁盘凭证(失败不影响已删除结果)
    await removeExpenseFilesByRelativePaths(relativePaths);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/delete] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/delete] 失败", { name: (err as Error)?.name });
    return bad("删除失败,请稍后重试。", 500);
  }
}
