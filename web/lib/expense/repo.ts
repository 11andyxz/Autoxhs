/**
 * Business 花费(记账本)的数据访问层。复用收费计算器的共享 MySQL 连接池(getPool),
 * 表用 exp_ 前缀;首次使用时幂等建表(沿用项目里 ensure*Schema 的约定)。
 * 金额用 DECIMAL(12,2);日期用 DATE,配合池里的 dateStrings 以 'YYYY-MM-DD' 返回,避免时区漂移。
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import { parseAmount, type ExpenseInput } from "./validate";

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。失败时清空缓存以便下次重试。 */
export function ensureExpenseSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS exp_expense (
        id INT AUTO_INCREMENT PRIMARY KEY,
        spent_on DATE NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        category VARCHAR(100) NOT NULL,
        vendor VARCHAR(255) NOT NULL DEFAULT '',
        payment_method VARCHAR(50) NOT NULL DEFAULT '',
        note TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_exp_spent_on (spent_on),
        INDEX idx_exp_category (category)
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS exp_file (
        id INT AUTO_INCREMENT PRIMARY KEY,
        expense_id INT NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(255) NOT NULL,
        relative_path VARCHAR(700) NOT NULL,
        mime_type VARCHAR(127) NOT NULL,
        size_bytes INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_expfile_expense FOREIGN KEY (expense_id) REFERENCES exp_expense(id) ON DELETE CASCADE
      )
    `);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** 事务内:插入一条花费,返回新 id。amount 已在校验层保证合法。 */
export async function insertExpense(conn: PoolConnection, e: ExpenseInput): Promise<number> {
  const amount = parseAmount(e.amount);
  if (amount === null) throw new Error("金额非法");
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO exp_expense (spent_on, amount, category, vendor, payment_method, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [e.spentOn, amount, e.category, e.vendor, e.paymentMethod, e.note],
  );
  return res.insertId;
}

/** 事务内:按 id 更新花费基本字段(不动附件)。 */
export async function updateExpenseById(conn: PoolConnection, id: number, e: ExpenseInput): Promise<void> {
  const amount = parseAmount(e.amount);
  if (amount === null) throw new Error("金额非法");
  await conn.query(
    `UPDATE exp_expense
       SET spent_on = ?, amount = ?, category = ?, vendor = ?, payment_method = ?, note = ?
     WHERE id = ?`,
    [e.spentOn, amount, e.category, e.vendor, e.paymentMethod, e.note, id],
  );
}

/** 事务内:该 id 的花费是否存在。 */
export async function expenseExists(conn: PoolConnection, id: number): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM exp_expense WHERE id = ? LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

export interface NewFileRow {
  expenseId: number;
  originalName: string;
  storedName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export async function insertExpenseFile(conn: PoolConnection, f: NewFileRow): Promise<number> {
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO exp_file
       (expense_id, original_name, stored_name, relative_path, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.expenseId, f.originalName, f.storedName, f.relativePath, f.mimeType, f.sizeBytes],
  );
  return res.insertId;
}

export interface ExpenseFileItem {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ExpenseWithFiles {
  id: number;
  spentOn: string;
  amount: number;
  category: string;
  vendor: string;
  paymentMethod: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  files: ExpenseFileItem[];
}

/** 全部花费 + 其凭证(按日期倒序),供前端列表/编辑回显。 */
export async function listExpenses(): Promise<ExpenseWithFiles[]> {
  const p = getPool();
  const [expRows] = await p.query<RowDataPacket[]>(
    `SELECT id, spent_on, amount, category, vendor, payment_method, note, created_at, updated_at
     FROM exp_expense ORDER BY spent_on DESC, id DESC`,
  );
  const [fileRows] = await p.query<RowDataPacket[]>(
    `SELECT id, expense_id, original_name, mime_type, size_bytes, created_at
     FROM exp_file ORDER BY id ASC`,
  );

  const filesByExp = new Map<number, ExpenseFileItem[]>();
  for (const r of fileRows) {
    const expId = r.expense_id as number;
    const list = filesByExp.get(expId) ?? [];
    list.push({
      id: r.id as number,
      originalName: r.original_name as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
      createdAt: r.created_at as string,
    });
    filesByExp.set(expId, list);
  }

  return expRows.map((r) => ({
    id: r.id as number,
    spentOn: r.spent_on as string,
    amount: Number(r.amount),
    category: r.category as string,
    vendor: (r.vendor as string) ?? "",
    paymentMethod: (r.payment_method as string) ?? "",
    note: (r.note as string) ?? "",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    files: filesByExp.get(r.id as number) ?? [],
  }));
}

export interface ExpenseSummary {
  /** 全部花费总额 */
  grandTotal: number;
  /** 记账笔数 */
  count: number;
  /** 按月汇总(month = 'YYYY-MM'),按月倒序 */
  byMonth: Array<{ month: string; total: number; count: number }>;
  /** 按类别汇总,按金额倒序 */
  byCategory: Array<{ category: string; total: number; count: number }>;
}

/** 汇总统计(SQL 聚合,金额精确)。反映整本账,不受列表筛选影响。 */
export async function getExpenseSummary(): Promise<ExpenseSummary> {
  const p = getPool();
  const [totalRows] = await p.query<RowDataPacket[]>(
    "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt FROM exp_expense",
  );
  const [monthRows] = await p.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(spent_on, '%Y-%m') AS month, SUM(amount) AS total, COUNT(*) AS cnt
     FROM exp_expense GROUP BY month ORDER BY month DESC`,
  );
  const [catRows] = await p.query<RowDataPacket[]>(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS cnt
     FROM exp_expense GROUP BY category ORDER BY total DESC`,
  );
  return {
    grandTotal: Number(totalRows[0]?.total ?? 0),
    count: Number(totalRows[0]?.cnt ?? 0),
    byMonth: monthRows.map((r) => ({
      month: r.month as string,
      total: Number(r.total),
      count: Number(r.cnt),
    })),
    byCategory: catRows.map((r) => ({
      category: r.category as string,
      total: Number(r.total),
      count: Number(r.cnt),
    })),
  };
}

export interface StoredFileRef {
  id: number;
  expenseId: number;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

/** 取单个凭证的存储引用,供下载/删除接口使用。 */
export async function getExpenseFileById(id: number): Promise<StoredFileRef | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, expense_id, original_name, relative_path, mime_type, size_bytes
     FROM exp_file WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id as number,
    expenseId: r.expense_id as number,
    originalName: r.original_name as string,
    relativePath: r.relative_path as string,
    mimeType: r.mime_type as string,
    sizeBytes: Number(r.size_bytes),
  };
}

/**
 * 删除一条花费:先取出其全部凭证相对路径(供调用方清理磁盘),
 * 再删除花费行(exp_file 由 CASCADE 一并删除)。返回受影响行数与凭证路径。
 */
export async function deleteExpenseById(
  id: number,
): Promise<{ deleted: number; relativePaths: string[] }> {
  const p = getPool();
  const [fileRows] = await p.query<RowDataPacket[]>(
    "SELECT relative_path FROM exp_file WHERE expense_id = ?",
    [id],
  );
  const relativePaths = fileRows.map((r) => r.relative_path as string);
  const [res] = await p.query<ResultSetHeader>("DELETE FROM exp_expense WHERE id = ?", [id]);
  return { deleted: res.affectedRows, relativePaths };
}

/**
 * 删除单个凭证:返回其相对路径(供调用方清理磁盘)与是否删除成功。
 * 不存在返回 relativePath=null。
 */
export async function deleteExpenseFileById(
  id: number,
): Promise<{ deleted: number; relativePath: string | null }> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT relative_path FROM exp_file WHERE id = ? LIMIT 1",
    [id],
  );
  if (!rows.length) return { deleted: 0, relativePath: null };
  const relativePath = rows[0].relative_path as string;
  const [res] = await p.query<ResultSetHeader>("DELETE FROM exp_file WHERE id = ?", [id]);
  return { deleted: res.affectedRows, relativePath };
}
