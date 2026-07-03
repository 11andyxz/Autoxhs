/**
 * 「花费」新建/编辑接口共用的请求体处理:
 * 限量读体(防内存耗尽 DoS)、multipart 解析+校验、凭证落盘。仅服务器端。
 */
import type { PoolConnection } from "mysql2/promise";
import type { NextRequest } from "next/server";

import { insertExpenseFile } from "./repo";
import { mimeForName, saveExpenseFile } from "./storage";
import {
  isAllowedFileName,
  MAX_FILE_BYTES,
  trimExpense,
  validateExpense,
  type ExpenseInput,
} from "./validate";

/** 每条花费最多附带的凭证数 */
export const MAX_FILES = 15;
/** 上传请求体硬上限:防止 formData() 无上限缓冲整个 body 造成内存耗尽 */
export const MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES + 4 * 1024 * 1024;

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

export type ParsedExpenseForm =
  | { ok: true; expense: ExpenseInput; files: File[] }
  | { ok: false; error: string };

/**
 * 从 multipart 表单解析花费字段 + 凭证文件。校验失败返回中文错误。
 * 凭证为选填(可 0 个)。
 */
export function parseExpenseForm(form: FormData): ParsedExpenseForm {
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const expense = trimExpense({
    spentOn: str("spentOn"),
    amount: str("amount"),
    category: str("category"),
    vendor: str("vendor"),
    paymentMethod: str("paymentMethod"),
    note: str("note"),
  });
  const errors = validateExpense(expense);
  if (errors.length) return { ok: false, error: errors[0] };

  const rawFiles = form.getAll("files");
  const files: File[] = [];
  for (const f of rawFiles) {
    if (!(f instanceof File)) return { ok: false, error: "凭证上传格式有误,请重试。" };
    files.push(f);
  }
  if (files.length > MAX_FILES) return { ok: false, error: `一次最多上传 ${MAX_FILES} 个凭证。` };

  for (const file of files) {
    if (file.size === 0) return { ok: false, error: `凭证「${file.name}」是空文件,请重新选择。` };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: `凭证「${file.name}」超过 20MB 上限。` };
    if (!isAllowedFileName(file.name)) {
      return { ok: false, error: `凭证「${file.name}」类型不支持(仅 PDF / 图片 / Word)。` };
    }
  }
  return { ok: true, expense, files };
}

/**
 * 事务内:把已校验的凭证落盘并写入 exp_file。已落盘的绝对路径会 push 进 writtenPaths,
 * 供调用方在回滚时清理(避免孤儿文件)。
 */
export async function persistExpenseFiles(
  conn: PoolConnection,
  expenseId: number,
  files: File[],
  writtenPaths: string[],
): Promise<void> {
  for (const file of files) {
    const buf = Buffer.from(await file.arrayBuffer());
    const saved = await saveExpenseFile(expenseId, file.name, buf);
    writtenPaths.push(saved.absPath);
    await insertExpenseFile(conn, {
      expenseId,
      originalName: file.name,
      storedName: saved.storedName,
      relativePath: saved.relativePath,
      mimeType: mimeForName(file.name, file.type),
      sizeBytes: file.size,
    });
  }
}
