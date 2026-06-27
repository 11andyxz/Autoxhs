/**
 * 雇员信息的数据访问层。复用收费计算器的共享 MySQL 连接池(getPool),
 * 表用 emp_ 前缀;首次使用时幂等建表(沿用项目里 ensure*Schema 的约定)。
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import { normalizeEmail, type EmployeeInput } from "./validate";

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。失败时清空缓存以便下次重试。 */
export function ensureEmployeeSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS emp_employee (
        id INT AUTO_INCREMENT PRIMARY KEY,
        normalized_email VARCHAR(255) NOT NULL UNIQUE,
        legal_first_name VARCHAR(255) NOT NULL,
        legal_last_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        address VARCHAR(512) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS emp_file (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        category VARCHAR(100) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(255) NOT NULL,
        relative_path VARCHAR(700) NOT NULL,
        mime_type VARCHAR(127) NOT NULL,
        size_bytes INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_empfile_employee FOREIGN KEY (employee_id) REFERENCES emp_employee(id) ON DELETE CASCADE
      )
    `);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/**
 * 事务内:按 normalized_email 唯一去重。已存在则更新基本信息并返回 created=false,
 * 否则插入并返回 created=true。
 */
export async function upsertEmployee(
  conn: PoolConnection,
  e: EmployeeInput,
): Promise<{ id: number; created: boolean }> {
  const normalized = normalizeEmail(e.email);
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM emp_employee WHERE normalized_email = ? LIMIT 1",
    [normalized],
  );
  if (rows.length) {
    const id = rows[0].id as number;
    await conn.query(
      `UPDATE emp_employee
         SET legal_first_name = ?, legal_last_name = ?, email = ?, address = ?, phone = ?
       WHERE id = ?`,
      [e.legalFirstName, e.legalLastName, e.email, e.address, e.phone, id],
    );
    return { id, created: false };
  }
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO emp_employee (normalized_email, legal_first_name, legal_last_name, email, address, phone)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [normalized, e.legalFirstName, e.legalLastName, e.email, e.address, e.phone],
  );
  return { id: res.insertId, created: true };
}

export interface NewFileRow {
  employeeId: number;
  category: string;
  originalName: string;
  storedName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export async function insertEmployeeFile(conn: PoolConnection, f: NewFileRow): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO emp_file
       (employee_id, category, original_name, stored_name, relative_path, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [f.employeeId, f.category, f.originalName, f.storedName, f.relativePath, f.mimeType, f.sizeBytes],
  );
  return res.insertId;
}

export interface EmployeeFileItem {
  id: number;
  category: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface EmployeeWithFiles {
  id: number;
  legalFirstName: string;
  legalLastName: string;
  email: string;
  address: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
  files: EmployeeFileItem[];
}

/** 全部雇员 + 其文件(按分类分组的扁平列表),供前端列表/查询回显。 */
export async function listEmployees(): Promise<EmployeeWithFiles[]> {
  const p = getPool();
  const [empRows] = await p.query<RowDataPacket[]>(
    `SELECT id, legal_first_name, legal_last_name, email, address, phone, created_at, updated_at
     FROM emp_employee ORDER BY created_at DESC, id DESC`,
  );
  const [fileRows] = await p.query<RowDataPacket[]>(
    `SELECT id, employee_id, category, original_name, mime_type, size_bytes, created_at
     FROM emp_file ORDER BY category ASC, id ASC`,
  );

  const filesByEmp = new Map<number, EmployeeFileItem[]>();
  for (const r of fileRows) {
    const empId = r.employee_id as number;
    const list = filesByEmp.get(empId) ?? [];
    list.push({
      id: r.id as number,
      category: r.category as string,
      originalName: r.original_name as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
      createdAt: r.created_at as string,
    });
    filesByEmp.set(empId, list);
  }

  return empRows.map((r) => ({
    id: r.id as number,
    legalFirstName: r.legal_first_name as string,
    legalLastName: r.legal_last_name as string,
    email: r.email as string,
    address: r.address as string,
    phone: r.phone as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    files: filesByEmp.get(r.id as number) ?? [],
  }));
}

export interface StoredFileRef {
  id: number;
  employeeId: number;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

/** 取单个文件的存储引用,供下载接口使用。 */
export async function getEmployeeFileById(id: number): Promise<StoredFileRef | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, employee_id, original_name, relative_path, mime_type, size_bytes
     FROM emp_file WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as number,
    employeeId: r.employee_id as number,
    originalName: r.original_name as string,
    relativePath: r.relative_path as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
  };
}
