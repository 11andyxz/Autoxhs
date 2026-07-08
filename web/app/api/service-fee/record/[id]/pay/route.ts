import { NextResponse, type NextRequest } from "next/server";

import { ensureSchema, getPool } from "@/lib/serviceFee/db";
import {
  feeRecordExists,
  insertPaymentFile,
  isAllowedFileName,
  listPaymentFilePaths,
  MAX_FILE_BYTES,
  mimeForName,
  removeFileSafe,
  removePaymentFilesByRelativePaths,
  savePaymentFile,
  setPaid,
} from "@/lib/serviceFee/payments";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES + 4 * 1024 * 1024;

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 标记该收费记录为「已付」,并上传付款凭证(至少 1 张)。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);
  const recordId = parseId((await params).id);
  if (recordId === null) return bad("无效的记录 ID。");

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return bad("上传内容过大,请减少凭证数量或体积。", 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return bad("请至少上传一张付款凭证。");
  if (files.length > MAX_FILES) return bad(`一次最多上传 ${MAX_FILES} 张凭证。`);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) return bad(`文件「${file.name}」超过 20MB 上限。`);
    if (!isAllowedFileName(file.name)) return bad(`文件「${file.name}」类型不支持(仅 PDF / 图片 / Word)。`);
  }

  await ensureSchema();
  if (!(await feeRecordExists(recordId))) return bad("收费记录不存在。", 404);

  const conn = await getPool().getConnection();
  const writtenPaths: string[] = [];
  try {
    await conn.beginTransaction();
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      const saved = await savePaymentFile(recordId, file.name, buf);
      writtenPaths.push(saved.absPath);
      await insertPaymentFile(conn, {
        recordId,
        originalName: file.name,
        storedName: saved.storedName,
        relativePath: saved.relativePath,
        mimeType: mimeForName(file.name, file.type),
        sizeBytes: file.size,
      });
    }
    await setPaid(conn, recordId, true);
    await conn.commit();
    return NextResponse.json({ success: true, paid: true, fileCount: files.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(writtenPaths.map((p) => removeFileSafe(p)));
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[service-fee/pay] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[service-fee/pay] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}

/** 撤销「已付」:改回未付并删除该记录的全部付款凭证(磁盘 + 记录)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);
  const recordId = parseId((await params).id);
  if (recordId === null) return bad("无效的记录 ID。");

  await ensureSchema();
  if (!(await feeRecordExists(recordId))) return bad("收费记录不存在。", 404);

  const paths = await listPaymentFilePaths(recordId);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM fee_payment_file WHERE record_id = ?", [recordId]);
    await setPaid(conn, recordId, false);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error("[service-fee/unpay] 失败", { name: (err as Error)?.name });
    return bad("撤销失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
  // DB 事务已成功,再清理磁盘(失败不影响状态,留下的孤儿文件无害)
  await removePaymentFilesByRelativePaths(paths);
  return NextResponse.json({ success: true, paid: false });
}
