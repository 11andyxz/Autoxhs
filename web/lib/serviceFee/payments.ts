/**
 * 收费记录(fee_records)的「已付」状态与付款凭证。仅服务器端(runtime="nodejs")。
 * 凭证存磁盘 <root>/service-fee-payments/<recordId>/<filename>,元数据存 fee_payment_file;
 * root 沿用项目统一上传根(uploads/,EMPLOYEE_UPLOAD_DIR 覆盖,已 gitignore)。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "./db";

/* ------------------------------ 文件类型/大小 ------------------------------ */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_FILE_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "gif", "doc", "docx"] as const;

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}
export function isAllowedFileName(name: string): boolean {
  return (ALLOWED_FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}
function sanitizeStoredFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).normalize("NFKC");
  const ext = fileExtension(base);
  const dot = base.lastIndexOf(".");
  const stem = ext && dot > 0 ? base.slice(0, dot) : base;
  const safe = stem.replace(/\.\.+/g, ".").replace(/[^A-Za-z0-9 _.\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
  return ext ? `${safe || "file"}.${ext}` : safe || "file";
}
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export function mimeForName(name: string, fallback?: string): string {
  return EXT_MIME[fileExtension(name)] ?? (fallback && fallback.trim() ? fallback : "application/octet-stream");
}

/* --------------------------------- 磁盘存储 --------------------------------- */

function uploadsRoot(): string {
  const override = process.env.EMPLOYEE_UPLOAD_DIR?.trim();
  return override ? path.resolve(override) : path.resolve(process.cwd(), "uploads");
}
function assertWithinRoot(absPath: string): string {
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(absPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("非法的文件路径");
  return resolved;
}

export interface SavedFile {
  storedName: string;
  relativePath: string;
  absPath: string;
}

/** 写入 <root>/service-fee-payments/<recordId>/<storedName>,同名自动加序号。 */
export async function savePaymentFile(recordId: number, originalName: string, data: Buffer): Promise<SavedFile> {
  const dir = path.join(uploadsRoot(), "service-fee-payments", String(recordId));
  assertWithinRoot(dir);
  await fs.mkdir(dir, { recursive: true });
  const baseName = sanitizeStoredFileName(originalName);
  const ext = fileExtension(baseName);
  const stem = ext ? baseName.slice(0, baseName.length - ext.length - 1) : baseName;
  let storedName = baseName;
  for (let i = 2; ; i += 1) {
    try {
      await fs.access(path.join(dir, storedName));
      storedName = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`;
    } catch {
      break;
    }
  }
  const absPath = assertWithinRoot(path.join(dir, storedName));
  await fs.writeFile(absPath, data, { flag: "wx" });
  const relativePath = path.relative(uploadsRoot(), absPath).split(path.sep).join("/");
  return { storedName, relativePath, absPath };
}
export function resolveStoredFile(relativePath: string): string {
  return assertWithinRoot(path.resolve(uploadsRoot(), relativePath));
}
export async function removeFileSafe(absPath: string): Promise<void> {
  try { await fs.unlink(absPath); } catch { /* ignore */ }
}
/** 按相对路径删一批凭证文件并尽力清空目录。 */
export async function removePaymentFilesByRelativePaths(relativePaths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of relativePaths) {
    let abs: string;
    try { abs = resolveStoredFile(rel); } catch { continue; }
    await removeFileSafe(abs);
    dirs.add(path.dirname(abs));
  }
  for (const dir of dirs) {
    try { assertWithinRoot(dir); await fs.rmdir(dir); } catch { /* ignore */ }
  }
}

/* --------------------------------- 数据访问 --------------------------------- */

export async function feeRecordExists(id: number): Promise<boolean> {
  const [rows] = await getPool().query<RowDataPacket[]>("SELECT id FROM fee_records WHERE id = ? LIMIT 1", [id]);
  return rows.length > 0;
}

/** 事务内设置 paid 状态。paid=true 时写 paid_at=当前时间;false 时清空。 */
export async function setPaid(conn: PoolConnection, recordId: number, paid: boolean): Promise<void> {
  await conn.query(
    "UPDATE fee_records SET paid = ?, paid_at = ? WHERE id = ?",
    [paid ? 1 : 0, paid ? new Date() : null, recordId],
  );
}

export interface NewPaymentFileRow {
  recordId: number;
  originalName: string;
  storedName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}
export async function insertPaymentFile(conn: PoolConnection, f: NewPaymentFileRow): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO fee_payment_file (record_id, original_name, stored_name, relative_path, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.recordId, f.originalName, f.storedName, f.relativePath, f.mimeType, f.sizeBytes],
  );
  return res.insertId;
}

/** 取该记录全部凭证的相对路径(撤销时清理磁盘用)。 */
export async function listPaymentFilePaths(recordId: number): Promise<string[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT relative_path FROM fee_payment_file WHERE record_id = ?",
    [recordId],
  );
  return rows.map((r) => r.relative_path as string);
}

export interface PaymentFileRef {
  id: number;
  originalName: string;
  relativePath: string;
  mimeType: string;
}
/** 取单个凭证(下载用)。 */
export async function getPaymentFileById(id: number): Promise<PaymentFileRef | null> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT id, original_name, relative_path, mime_type FROM fee_payment_file WHERE id = ? LIMIT 1",
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as number,
    originalName: r.original_name as string,
    relativePath: r.relative_path as string,
    mimeType: r.mime_type as string,
  };
}
