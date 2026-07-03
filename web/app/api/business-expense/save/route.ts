import { NextResponse, type NextRequest } from "next/server";

import {
  MAX_TOTAL_BYTES,
  parseExpenseForm,
  PayloadTooLargeError,
  persistExpenseFiles,
  readCappedFormData,
} from "@/lib/expense/form";
import { ensureExpenseSchema, insertExpense } from "@/lib/expense/repo";
import { removeFileSafe } from "@/lib/expense/storage";
import { getPool } from "@/lib/serviceFee/db";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 新建一条花费(可附凭证)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

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
  const conn = await getPool().getConnection();
  const writtenPaths: string[] = [];
  try {
    await conn.beginTransaction();
    const expenseId = await insertExpense(conn, parsed.expense);
    await persistExpenseFiles(conn, expenseId, parsed.files, writtenPaths);
    await conn.commit();
    return NextResponse.json({ success: true, expenseId, fileCount: parsed.files.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => removeFileSafe(p)));
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/save] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/save] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}
