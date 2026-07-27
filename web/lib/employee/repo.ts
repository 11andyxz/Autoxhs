/**
 * 雇员信息的数据访问层。复用收费计算器的共享 MySQL 连接池(getPool),
 * 表用 emp_ 前缀;首次使用时幂等建表(沿用项目里 ensure*Schema 的约定)。
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import { formatEmailList, normalizeEmail, parseEmailList, type EmployeeInput } from "./validate";

let schemaReady: Promise<void> | null = null;

/**
 * 幂等补列:老库已存在表时 CREATE TABLE IF NOT EXISTS 不会补列。
 * information_schema 在 Aiven 上可能滞后,所以「已存在」也可能漏判 —— 因此
 * ALTER 失败时只要是「列已存在」就当成功(靠错误码兜底,不迷信目录表)。
 */
async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;
  try {
    await p.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "ER_DUP_FIELDNAME") throw err;
  }
}

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
        extra_emails TEXT NULL,
        address VARCHAR(512) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        notes TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // 旧库已存在 emp_employee 时,CREATE TABLE IF NOT EXISTS 不会补列;此处幂等补后加的列
    await ensureColumn("emp_employee", "notes", "notes TEXT NULL AFTER phone");
    await ensureColumn("emp_employee", "extra_emails", "extra_emails TEXT NULL AFTER email");
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
    // 分类「空占位」:记录某雇员应有但尚无文件的分类(key),用于展示缺失栏目并支持「从他人复制分类」。
    // 一个分类有文件即由 emp_file 体现;无文件的分类靠此表持久保留。UNIQUE 防同名重复占位。
    await p.query(`
      CREATE TABLE IF NOT EXISTS emp_category (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        category VARCHAR(100) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_empcat_employee_category (employee_id, category),
        CONSTRAINT fk_empcat_employee FOREIGN KEY (employee_id) REFERENCES emp_employee(id) ON DELETE CASCADE
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
  const extraEmails = formatEmailList(e.extraEmails ?? []);
  if (rows.length) {
    const id = rows[0].id as number;
    await conn.query(
      `UPDATE emp_employee
         SET legal_first_name = ?, legal_last_name = ?, email = ?, extra_emails = ?, address = ?, phone = ?, notes = ?
       WHERE id = ?`,
      [e.legalFirstName, e.legalLastName, e.email, extraEmails, e.address, e.phone, e.notes ?? "", id],
    );
    return { id, created: false };
  }
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO emp_employee (normalized_email, legal_first_name, legal_last_name, email, extra_emails, address, phone, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [normalized, e.legalFirstName, e.legalLastName, e.email, extraEmails, e.address, e.phone, e.notes ?? ""],
  );
  return { id: res.insertId, created: true };
}

/** 事务内:该 id 的雇员是否存在。 */
export async function employeeExists(conn: PoolConnection, id: number): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM emp_employee WHERE id = ? LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

/** 事务内:某 normalized_email 是否已被「另一个」雇员占用(用于改 email 时查重)。 */
export async function emailUsedByAnother(
  conn: PoolConnection,
  normalized: string,
  excludeId: number,
): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM emp_employee WHERE normalized_email = ? AND id <> ? LIMIT 1",
    [normalized, excludeId],
  );
  return rows.length > 0;
}

/** 事务内:按 id 精确更新雇员的全部字段(含 email / notes)。 */
export async function updateEmployeeById(
  conn: PoolConnection,
  id: number,
  e: EmployeeInput,
): Promise<void> {
  await conn.query(
    `UPDATE emp_employee
       SET normalized_email = ?, legal_first_name = ?, legal_last_name = ?, email = ?, extra_emails = ?, address = ?, phone = ?, notes = ?
     WHERE id = ?`,
    [
      normalizeEmail(e.email),
      e.legalFirstName,
      e.legalLastName,
      e.email,
      formatEmailList(e.extraEmails ?? []),
      e.address,
      e.phone,
      e.notes ?? "",
      id,
    ],
  );
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
  /** 主邮箱(去重键) */
  email: string;
  /** 备用邮箱(可为空数组) */
  extraEmails: string[];
  address: string;
  phone: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  files: EmployeeFileItem[];
  /** 已登记但尚无文件的分类(空占位),用于展示「缺失」栏目。已有文件的分类不在此列。 */
  emptyCategories: string[];
}

/** 全部雇员 + 其文件(按分类分组的扁平列表),供前端列表/查询回显。 */
export async function listEmployees(): Promise<EmployeeWithFiles[]> {
  const p = getPool();
  const [empRows] = await p.query<RowDataPacket[]>(
    `SELECT id, legal_first_name, legal_last_name, email, extra_emails, address, phone, notes, created_at, updated_at
     FROM emp_employee ORDER BY created_at DESC, id DESC`,
  );
  const [fileRows] = await p.query<RowDataPacket[]>(
    `SELECT id, employee_id, category, original_name, mime_type, size_bytes, created_at
     FROM emp_file ORDER BY category ASC, id ASC`,
  );
  const [slotRows] = await p.query<RowDataPacket[]>(
    `SELECT employee_id, category FROM emp_category ORDER BY category ASC`,
  );

  const filesByEmp = new Map<number, EmployeeFileItem[]>();
  // 每个雇员「有文件的分类」集合(小写),用于把空占位里已经有文件的分类剔除
  const fileCatLowerByEmp = new Map<number, Set<string>>();
  for (const r of fileRows) {
    const empId = r.employee_id as number;
    const category = r.category as string;
    const list = filesByEmp.get(empId) ?? [];
    list.push({
      id: r.id as number,
      category,
      originalName: r.original_name as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
      createdAt: r.created_at as string,
    });
    filesByEmp.set(empId, list);
    const lset = fileCatLowerByEmp.get(empId) ?? new Set<string>();
    lset.add(category.toLowerCase());
    fileCatLowerByEmp.set(empId, lset);
  }

  // 空占位分类 = emp_category 里、且该雇员没有同名(不分大小写)文件的分类
  const emptyCatsByEmp = new Map<number, string[]>();
  for (const r of slotRows) {
    const empId = r.employee_id as number;
    const category = r.category as string;
    if (fileCatLowerByEmp.get(empId)?.has(category.toLowerCase())) continue;
    const list = emptyCatsByEmp.get(empId) ?? [];
    list.push(category);
    emptyCatsByEmp.set(empId, list);
  }

  return empRows.map((r) => ({
    id: r.id as number,
    legalFirstName: r.legal_first_name as string,
    legalLastName: r.legal_last_name as string,
    email: r.email as string,
    extraEmails: parseEmailList((r.extra_emails as string | null) ?? ""),
    address: r.address as string,
    phone: r.phone as string,
    notes: (r.notes as string) ?? "",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    files: filesByEmp.get(r.id as number) ?? [],
    emptyCategories: emptyCatsByEmp.get(r.id as number) ?? [],
  }));
}

/**
 * 事务内:取某雇员的全部分类 key(去重)= 有文件的分类 ∪ 空占位分类。
 * 用于「复制分类」时读取来源集合、以及计算目标已有集合。
 */
export async function getCategoryKeysForEmployee(
  conn: PoolConnection,
  employeeId: number,
): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT category FROM emp_file WHERE employee_id = ?
     UNION
     SELECT category FROM emp_category WHERE employee_id = ?`,
    [employeeId, employeeId],
  );
  return rows.map((r) => r.category as string);
}

/**
 * 事务内:把若干分类作为「空占位」插入目标雇员(INSERT IGNORE 跳过已存在的)。
 * 返回实际新增的行数。categories 应已清洗且非空。
 */
export async function insertCategorySlots(
  conn: PoolConnection,
  employeeId: number,
  categories: string[],
): Promise<number> {
  if (!categories.length) return 0;
  const values = categories.map((c) => [employeeId, c]);
  const [res] = await conn.query<ResultSetHeader>(
    "INSERT IGNORE INTO emp_category (employee_id, category) VALUES ?",
    [values],
  );
  return res.affectedRows;
}

export interface StoredFileRef {
  id: number;
  employeeId: number;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StoredFileRefWithCategory extends StoredFileRef {
  category: string;
  createdAt: string;
}

/**
 * 取若干雇员的全部文件存储引用(含分类),供服务端读取文件内容用
 * (如从 payroll summary PDF 里读雇主税)。employeeIds 为空则返回空数组。
 */
export async function listStoredFilesForEmployees(
  employeeIds: number[],
): Promise<StoredFileRefWithCategory[]> {
  if (!employeeIds.length) return [];
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, employee_id, category, original_name, relative_path, mime_type, size_bytes, created_at
       FROM emp_file WHERE employee_id IN (?) ORDER BY created_at ASC, id ASC`,
    [employeeIds],
  );
  return rows.map((r) => ({
    id: r.id as number,
    employeeId: r.employee_id as number,
    category: r.category as string,
    originalName: r.original_name as string,
    relativePath: r.relative_path as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
    createdAt: String(r.created_at),
  }));
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
