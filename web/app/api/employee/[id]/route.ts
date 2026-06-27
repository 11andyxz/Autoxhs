import { NextResponse, type NextRequest } from "next/server";

import {
  MAX_TOTAL_BYTES,
  parseEmployeeForm,
  PayloadTooLargeError,
  persistEmployeeFiles,
  readCappedFormData,
} from "@/lib/employee/form";
import {
  emailUsedByAnother,
  employeeExists,
  ensureEmployeeSchema,
  updateEmployeeById,
} from "@/lib/employee/repo";
import { removeFileSafe } from "@/lib/employee/storage";
import { normalizeEmail } from "@/lib/employee/validate";
import { getPool } from "@/lib/serviceFee/db";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 按 employeeId 精确更新雇员信息(可改 email、补备注),并可追加文件。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const { id } = await params;
  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    return bad("无效的雇员 ID。");
  }

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return bad("上传内容过大,请减少文件数量或体积。", 413);
  }
  let form: FormData;
  try {
    form = await readCappedFormData(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return bad("上传内容过大,请减少文件数量或体积。", 413);
    }
    return bad("请求格式有误。");
  }

  const parsed = parseEmployeeForm(form);
  if (!parsed.ok) return bad(parsed.error);

  await ensureEmployeeSchema();
  const conn = await getPool().getConnection();
  const writtenPaths: string[] = [];
  try {
    await conn.beginTransaction();

    if (!(await employeeExists(conn, employeeId))) {
      await conn.rollback();
      return bad("雇员不存在。", 404);
    }
    // 改 email 时:若新邮箱已被其他雇员占用则拒绝(避免撞唯一键)
    if (await emailUsedByAnother(conn, normalizeEmail(parsed.employee.email), employeeId)) {
      await conn.rollback();
      return bad("该邮箱已被其他雇员占用。");
    }

    await updateEmployeeById(conn, employeeId, parsed.employee);
    await persistEmployeeFiles(conn, employeeId, parsed.prepared, writtenPaths);

    await conn.commit();
    return NextResponse.json({ success: true, employeeId, fileCount: parsed.prepared.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => removeFileSafe(p)));
    const code = (err as { code?: string } | null)?.code;
    // 并发改 email 撞到唯一键(预检查与 UPDATE 非原子)时给出明确提示,而非误判为数据库故障
    if (code === "ER_DUP_ENTRY") return bad("该邮箱已被其他雇员占用。");
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[employee/update] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[employee/update] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}
