/**
 * 「雇员信息」新建/编辑接口共用的请求体处理:
 * 限量读体(防内存耗尽 DoS)、multipart 解析+校验、文件落盘。仅服务器端。
 */
import type { PoolConnection } from "mysql2/promise";
import type { NextRequest } from "next/server";

import { insertEmployeeFile } from "./repo";
import { mimeForName, saveEmployeeFile } from "./storage";
import {
  isAllowedFileName,
  MAX_FILE_BYTES,
  sanitizeCategoryName,
  trimEmployee,
  validateEmployee,
  type EmployeeInput,
} from "./validate";

export const MAX_FILES = 30;
/** 上传请求体硬上限:防止 formData() 无上限缓冲整个 body 造成内存耗尽 */
export const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES + 8 * 1024 * 1024;

export class PayloadTooLargeError extends Error {}

/**
 * 限量读取请求体后再解析为 FormData。即使缺少或伪造 Content-Length,
 * 一旦累计字节超过上限就立即中止,避免内存耗尽型 DoS。
 */
export async function readCappedFormData(req: NextRequest, cap = MAX_TOTAL_BYTES): Promise<FormData> {
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

export interface PreparedFile {
  file: File;
  category: string;
}

export type ParsedEmployeeForm =
  | { ok: true; employee: EmployeeInput; prepared: PreparedFile[] }
  | { ok: false; error: string };

/**
 * 从 multipart 表单解析雇员字段 + 文件。文件与分类按下标一一对应,
 * 不按大小过滤(否则会与 categories 数组错位)。校验失败返回中文错误。
 */
export function parseEmployeeForm(form: FormData): ParsedEmployeeForm {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const employee = trimEmployee({
    legalFirstName: str("legalFirstName"),
    legalLastName: str("legalLastName"),
    email: str("email"),
    address: str("address"),
    phone: str("phone"),
    notes: str("notes"),
  });
  const errors = validateEmployee(employee);
  if (errors.length) return { ok: false, error: errors[0] };

  const rawFiles = form.getAll("files");
  const files: File[] = [];
  for (const f of rawFiles) {
    if (!(f instanceof File)) return { ok: false, error: "文件上传格式有误,请重试。" };
    files.push(f);
  }
  let categories: string[] = [];
  try {
    const parsed = JSON.parse(str("categories") || "[]");
    if (Array.isArray(parsed)) categories = parsed.map((c) => String(c ?? ""));
  } catch {
    return { ok: false, error: "文件分类信息格式有误。" };
  }
  if (files.length > MAX_FILES) return { ok: false, error: `一次最多上传 ${MAX_FILES} 个文件。` };
  if (categories.length !== files.length) return { ok: false, error: "文件与分类数量不匹配,请重试。" };

  const prepared: PreparedFile[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file.size === 0) return { ok: false, error: `文件「${file.name}」是空文件,请重新选择。` };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: `文件「${file.name}」超过 20MB 上限。` };
    if (!isAllowedFileName(file.name)) {
      return { ok: false, error: `文件「${file.name}」类型不支持(仅 PDF / 图片 / Word)。` };
    }
    const category = sanitizeCategoryName(categories[i] ?? "");
    if (!category) return { ok: false, error: `请为文件「${file.name}」填写分类(例如 i983)。` };
    prepared.push({ file, category });
  }
  return { ok: true, employee, prepared };
}

/**
 * 事务内:把已校验的文件落盘并写入 emp_file。已落盘的绝对路径会 push 进 writtenPaths,
 * 供调用方在回滚时清理(避免孤儿文件)。
 */
export async function persistEmployeeFiles(
  conn: PoolConnection,
  employeeId: number,
  prepared: PreparedFile[],
  writtenPaths: string[],
): Promise<void> {
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
}
