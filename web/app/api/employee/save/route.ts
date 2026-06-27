import { NextResponse, type NextRequest } from "next/server";

import { ensureEmployeeSchema, insertEmployeeFile, upsertEmployee } from "@/lib/employee/repo";
import { getPool } from "@/lib/serviceFee/db";
import { mimeForName, removeFileSafe, saveEmployeeFile } from "@/lib/employee/storage";
import {
  isAllowedFileName,
  MAX_FILE_BYTES,
  sanitizeCategoryName,
  trimEmployee,
  validateEmployee,
  type EmployeeInput,
} from "@/lib/employee/validate";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 30;
// 上传请求体硬上限:防止 req.formData() 无上限缓冲整个 body 造成内存耗尽
const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES + 8 * 1024 * 1024;

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

class PayloadTooLargeError extends Error {}

/**
 * 限量读取请求体后再解析为 FormData。即使缺少或伪造 Content-Length,
 * 一旦累计字节超过上限就立即中止,避免内存耗尽型 DoS。
 */
async function readCappedFormData(req: NextRequest, cap: number): Promise<FormData> {
  const contentType = req.headers.get("content-type") || "";
  if (!req.body) return req.formData();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  }
  reader.releaseLock();
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(merged, { headers: { "content-type": contentType } }).formData();
}

export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  // 先按 Content-Length 快速拒绝(诚实客户端会带上),再限量读取兜底
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return bad("上传内容过大,请减少文件数量或体积。", 413);
  }
  let form: FormData;
  try {
    form = await readCappedFormData(req, MAX_TOTAL_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return bad("上传内容过大,请减少文件数量或体积。", 413);
    }
    return bad("请求格式有误。");
  }

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const raw: EmployeeInput = {
    legalFirstName: str("legalFirstName"),
    legalLastName: str("legalLastName"),
    email: str("email"),
    address: str("address"),
    phone: str("phone"),
  };
  const employee = trimEmployee(raw);
  const errors = validateEmployee(employee);
  if (errors.length) return bad(errors[0]);

  // 文件与分类按下标一一对应:不在此处按大小过滤,否则会与 categories 数组错位
  const rawFiles = form.getAll("files");
  const files: File[] = [];
  for (const f of rawFiles) {
    if (!(f instanceof File)) return bad("文件上传格式有误,请重试。");
    files.push(f);
  }
  let categories: string[] = [];
  try {
    const parsed = JSON.parse(str("categories") || "[]");
    if (Array.isArray(parsed)) categories = parsed.map((c) => String(c ?? ""));
  } catch {
    return bad("文件分类信息格式有误。");
  }

  if (files.length > MAX_FILES) return bad(`一次最多上传 ${MAX_FILES} 个文件。`);
  if (categories.length !== files.length) return bad("文件与分类数量不匹配,请重试。");

  // 逐个校验文件类型/大小/分类(分类必填)
  const prepared: Array<{ file: File; category: string }> = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file.size === 0) return bad(`文件「${file.name}」是空文件,请重新选择。`);
    if (file.size > MAX_FILE_BYTES) return bad(`文件「${file.name}」超过 20MB 上限。`);
    if (!isAllowedFileName(file.name)) {
      return bad(`文件「${file.name}」类型不支持(仅 PDF / 图片 / Word)。`);
    }
    const category = sanitizeCategoryName(categories[i] ?? "");
    if (!category) return bad(`请为文件「${file.name}」填写分类(例如 i983)。`);
    prepared.push({ file, category });
  }

  await ensureEmployeeSchema();
  const conn = await getPool().getConnection();
  const writtenPaths: string[] = [];
  try {
    await conn.beginTransaction();
    const { id: employeeId, created } = await upsertEmployee(conn, employee);

    for (const { file, category } of prepared) {
      const buf = Buffer.from(await file.arrayBuffer());
      const saved = await saveEmployeeFile(employeeId, category, file.name, buf);
      writtenPaths.push(saved.absPath);
      await insertEmployeeFile(conn, {
        employeeId,
        category,
        originalName: file.name,
        storedName: saved.storedName,
        relativePath: saved.relativePath,
        mimeType: mimeForName(file.name, file.type),
        sizeBytes: file.size,
      });
    }

    await conn.commit();
    return NextResponse.json({
      success: true,
      employeeId,
      created,
      fileCount: prepared.length,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    // 回滚后清理已落盘文件,避免孤儿文件
    await Promise.all(writtenPaths.map((p) => removeFileSafe(p)));
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[employee/save] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[employee/save] 失败", { name: (err as Error)?.name });
    return bad("保存失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}
