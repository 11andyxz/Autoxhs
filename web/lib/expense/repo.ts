/**
 * Business 花费(记账本)的数据访问层。复用收费计算器的共享 MySQL 连接池(getPool),
 * 表用 exp_ 前缀;首次使用时幂等建表 + 幂等迁移(沿用项目里 ensure*Schema 的约定)。
 *
 * 数据模型:
 *  - exp_business:business 大分类(受控清单,仿 serviceFee 的 clients)。
 *  - exp_expense :每笔收支,type=expense|income,金额恒为正,归属一个 business。
 *  - exp_file    :凭证附件,随 expense 级联删除。
 * 金额用 DECIMAL(12,2);日期用 DATE,配合池里的 dateStrings 以 'YYYY-MM-DD' 返回,避免时区漂移。
 */
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import {
  normalizeBusinessName,
  parseAmount,
  type ExpenseInput,
  type ExpenseType,
} from "./validate";

let schemaReady: Promise<void> | null = null;

async function columnExists(table: string, column: string): Promise<boolean> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function constraintExists(table: string, name: string): Promise<boolean> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.table_constraints
     WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?`,
    [table, name],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * 迁移完成标记(记在 exp_meta 表)。不依赖 information_schema——
 * 该实例上 information_schema 的 is_nullable 在 DDL 后可能短暂滞后,不可作为幂等判据。
 */
async function migrationDone(key: string): Promise<boolean> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>("SELECT 1 FROM exp_meta WHERE k = ? LIMIT 1", [key]);
  return rows.length > 0;
}
async function markMigrationDone(key: string): Promise<void> {
  const p = getPool();
  await p.query("INSERT IGNORE INTO exp_meta (k, v) VALUES (?, '1')", [key]);
}

/** 执行 DDL,忽略「目标已是期望状态」的错误码(列/键已存在),让迁移可安全重跑。 */
async function execIgnoring(sql: string, ignoreCodes: string[]): Promise<void> {
  const p = getPool();
  try {
    await p.query(sql);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (!code || !ignoreCodes.includes(code)) throw err;
  }
}

/** 首次使用时建表 + 幂等迁移(把旧版单一支出账本升级为「多 business + 收支」)。 */
export function ensureExpenseSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();

    // 0) 迁移标记表(幂等判据的可靠来源,不依赖 information_schema)
    await p.query(`
      CREATE TABLE IF NOT EXISTS exp_meta (
        k VARCHAR(64) PRIMARY KEY,
        v VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 1) business 大分类
    await p.query(`
      CREATE TABLE IF NOT EXISTS exp_business (
        id INT AUTO_INCREMENT PRIMARY KEY,
        normalized_name VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2) 收支表(基础列 = 旧版结构;新列通过下方幂等迁移补齐)
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

    // 2a) 收支类型:旧数据默认 'expense'(ADD 容忍列已存在,兼容 information_schema 滞后)
    if (!(await columnExists("exp_expense", "type"))) {
      await execIgnoring(
        "ALTER TABLE exp_expense ADD COLUMN type VARCHAR(10) NOT NULL DEFAULT 'expense' AFTER id",
        ["ER_DUP_FIELDNAME"],
      );
    }

    // 2b) 归属 business:整块由迁移标记 exp_business_v2 守卫,可安全重跑(自愈)。
    //   顺序:加列(可空,容忍已存在)→ 回填 NULL 行到「未分类」→ 置 NOT NULL → 补外键。
    //   标记未落定前,任何中断都会在下次完整重跑本块,消除残留的 business_id=NULL 行,
    //   从而杜绝「明细(INNER JOIN 隐藏 NULL 行)与汇总(计入 NULL 行)对不上」。
    if (!(await migrationDone("exp_business_v2"))) {
      if (!(await columnExists("exp_expense", "business_id"))) {
        await execIgnoring("ALTER TABLE exp_expense ADD COLUMN business_id INT NULL AFTER type", ["ER_DUP_FIELDNAME"]);
      }
      const [nullRows] = await p.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM exp_expense WHERE business_id IS NULL",
      );
      if (Number(nullRows[0]?.n ?? 0) > 0) {
        const defaultId = await ensureBusinessByName(p, "未分类");
        await p.query("UPDATE exp_expense SET business_id = ? WHERE business_id IS NULL", [defaultId]);
      }
      // 此时已无 NULL 行,置 NOT NULL 必定成功;对已是 NOT NULL 的列重复执行也安全。
      await p.query("ALTER TABLE exp_expense MODIFY business_id INT NOT NULL");
      if (!(await constraintExists("exp_expense", "fk_exp_business"))) {
        await execIgnoring(
          "ALTER TABLE exp_expense ADD CONSTRAINT fk_exp_business FOREIGN KEY (business_id) REFERENCES exp_business(id)",
          ["ER_FK_DUP_NAME", "ER_DUP_KEYNAME", "ER_CANT_CREATE_TABLE"],
        );
      }
      await markMigrationDone("exp_business_v2");
    }

    // 3) 凭证附件
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

/** 用连接池/连接确保某 business 存在(按归一名),返回其 id。用于迁移回填等场景。 */
async function ensureBusinessByName(
  runner: { query: PoolConnection["query"] },
  displayName: string,
): Promise<number> {
  const normalized = normalizeBusinessName(displayName);
  const [rows] = await runner.query<RowDataPacket[]>(
    "SELECT id FROM exp_business WHERE normalized_name = ? LIMIT 1",
    [normalized],
  );
  if (rows.length) return rows[0].id as number;
  const [res] = await runner.query<ResultSetHeader>(
    "INSERT INTO exp_business (normalized_name, display_name) VALUES (?, ?)",
    [normalized, displayName.trim()],
  );
  return res.insertId;
}

/* ----------------------------- business 大分类 ----------------------------- */

export interface BusinessItem {
  id: number;
  displayName: string;
  createdAt: string;
}

export async function listBusinesses(): Promise<BusinessItem[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT id, display_name, created_at FROM exp_business ORDER BY display_name ASC",
  );
  return rows.map((r) => ({
    id: r.id as number,
    displayName: r.display_name as string,
    createdAt: r.created_at as string,
  }));
}

/** 新建 business。名称已存在(按归一名)则返回既有 id,created=false。 */
export async function createBusiness(displayName: string): Promise<{ id: number; created: boolean }> {
  const p = getPool();
  const normalized = normalizeBusinessName(displayName);
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT id FROM exp_business WHERE normalized_name = ? LIMIT 1",
    [normalized],
  );
  if (rows.length) return { id: rows[0].id as number, created: false };
  const [res] = await p.query<ResultSetHeader>(
    "INSERT INTO exp_business (normalized_name, display_name) VALUES (?, ?)",
    [normalized, displayName.trim()],
  );
  return { id: res.insertId, created: true };
}

export async function businessExists(id: number): Promise<boolean> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT id FROM exp_business WHERE id = ? LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

/** 改名。新名(归一后)被别的 business 占用则报错返回 false。 */
export async function renameBusiness(id: number, displayName: string): Promise<{ ok: boolean; conflict?: boolean }> {
  const p = getPool();
  const normalized = normalizeBusinessName(displayName);
  const [dup] = await p.query<RowDataPacket[]>(
    "SELECT id FROM exp_business WHERE normalized_name = ? AND id <> ? LIMIT 1",
    [normalized, id],
  );
  if (dup.length) return { ok: false, conflict: true };
  const [res] = await p.query<ResultSetHeader>(
    "UPDATE exp_business SET normalized_name = ?, display_name = ? WHERE id = ?",
    [normalized, displayName.trim(), id],
  );
  return { ok: res.affectedRows > 0 };
}

/** 删除 business:仅当其名下没有任何记录时允许。返回 inUse=true 表示因有记录被拒。 */
export async function deleteBusinessIfEmpty(id: number): Promise<{ deleted: number; inUse?: boolean }> {
  const p = getPool();
  const [cnt] = await p.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM exp_expense WHERE business_id = ?",
    [id],
  );
  if (Number(cnt[0]?.n ?? 0) > 0) return { deleted: 0, inUse: true };
  const [res] = await p.query<ResultSetHeader>("DELETE FROM exp_business WHERE id = ?", [id]);
  return { deleted: res.affectedRows };
}

/* --------------------------------- 收支 --------------------------------- */

export async function insertExpense(conn: PoolConnection, e: ExpenseInput): Promise<number> {
  const amount = parseAmount(e.amount);
  if (amount === null) throw new Error("金额非法");
  const [res] = await conn.query<ResultSetHeader>(
    `INSERT INTO exp_expense (business_id, type, spent_on, amount, category, vendor, payment_method, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(e.businessId), e.type, e.spentOn, amount, e.category, e.vendor, e.paymentMethod, e.note],
  );
  return res.insertId;
}

export async function updateExpenseById(conn: PoolConnection, id: number, e: ExpenseInput): Promise<void> {
  const amount = parseAmount(e.amount);
  if (amount === null) throw new Error("金额非法");
  await conn.query(
    `UPDATE exp_expense
       SET business_id = ?, type = ?, spent_on = ?, amount = ?, category = ?, vendor = ?, payment_method = ?, note = ?
     WHERE id = ?`,
    [Number(e.businessId), e.type, e.spentOn, amount, e.category, e.vendor, e.paymentMethod, e.note, id],
  );
}

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
  businessId: number;
  businessName: string;
  type: ExpenseType;
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

/** 全部收支 + 其凭证(按日期倒序)。可选按 business 过滤。 */
export async function listExpenses(businessId?: number): Promise<ExpenseWithFiles[]> {
  const p = getPool();
  const where = businessId ? "WHERE e.business_id = ?" : "";
  const args = businessId ? [businessId] : [];
  const [expRows] = await p.query<RowDataPacket[]>(
    `SELECT e.id, e.business_id, b.display_name AS business_name, e.type, e.spent_on, e.amount,
            e.category, e.vendor, e.payment_method, e.note, e.created_at, e.updated_at
     FROM exp_expense e JOIN exp_business b ON b.id = e.business_id
     ${where}
     ORDER BY e.spent_on DESC, e.id DESC`,
    args,
  );
  const [fileRows] = await p.query<RowDataPacket[]>(
    `SELECT f.id, f.expense_id, f.original_name, f.mime_type, f.size_bytes, f.created_at
     FROM exp_file f JOIN exp_expense e ON e.id = f.expense_id
     ${where}
     ORDER BY f.id ASC`,
    args,
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
    businessId: r.business_id as number,
    businessName: r.business_name as string,
    type: (r.type as ExpenseType) ?? "expense",
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

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}
export interface ExpenseSummary {
  income: number;
  expense: number;
  /** 净额 = 收入 - 支出 */
  net: number;
  count: number;
  /** 按月(month = 'YYYY-MM'),按月倒序 */
  byMonth: Array<{ month: string; income: number; expense: number }>;
  byCategory: { expense: CategoryTotal[]; income: CategoryTotal[] };
}

/** 汇总统计(SQL 聚合,金额精确)。可选按 business 过滤;反映所选范围整本账。 */
export async function getExpenseSummary(businessId?: number): Promise<ExpenseSummary> {
  const p = getPool();
  const where = businessId ? "WHERE business_id = ?" : "";
  const args = businessId ? [businessId] : [];

  const [typeRows] = await p.query<RowDataPacket[]>(
    `SELECT type, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM exp_expense ${where} GROUP BY type`,
    args,
  );
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const r of typeRows) {
    const total = Number(r.total);
    const cnt = Number(r.cnt);
    count += cnt;
    if ((r.type as string) === "income") income = total;
    else expense = total;
  }

  const [monthRows] = await p.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(spent_on, '%Y-%m') AS month, type, SUM(amount) AS total
     FROM exp_expense ${where} GROUP BY month, type ORDER BY month DESC`,
    args,
  );
  const monthMap = new Map<string, { month: string; income: number; expense: number }>();
  const monthOrder: string[] = [];
  for (const r of monthRows) {
    const month = r.month as string;
    if (!monthMap.has(month)) {
      monthMap.set(month, { month, income: 0, expense: 0 });
      monthOrder.push(month);
    }
    const entry = monthMap.get(month)!;
    if ((r.type as string) === "income") entry.income = Number(r.total);
    else entry.expense = Number(r.total);
  }

  const [catRows] = await p.query<RowDataPacket[]>(
    `SELECT category, type, SUM(amount) AS total, COUNT(*) AS cnt
     FROM exp_expense ${where} GROUP BY category, type ORDER BY total DESC`,
    args,
  );
  const expenseByCategory: CategoryTotal[] = [];
  const incomeByCategory: CategoryTotal[] = [];
  for (const r of catRows) {
    const item = { category: r.category as string, total: Number(r.total), count: Number(r.cnt) };
    if ((r.type as string) === "income") incomeByCategory.push(item);
    else expenseByCategory.push(item);
  }

  return {
    income,
    expense,
    net: Math.round((income - expense) * 100) / 100,
    count,
    byMonth: monthOrder.map((m) => monthMap.get(m)!),
    byCategory: { expense: expenseByCategory, income: incomeByCategory },
  };
}

export interface BusinessTotal {
  businessId: number;
  businessName: string;
  income: number;
  expense: number;
  net: number;
  count: number;
}

/** 每个 business 的收入/支出/净额/笔数(用于导出的「按 business」汇总)。 */
export async function getBusinessTotals(): Promise<BusinessTotal[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT b.id, b.display_name,
            COALESCE(SUM(CASE WHEN e.type = 'income'  THEN e.amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount END), 0) AS expense,
            COUNT(e.id) AS cnt
     FROM exp_business b LEFT JOIN exp_expense e ON e.business_id = b.id
     GROUP BY b.id, b.display_name
     ORDER BY b.display_name ASC`,
  );
  return rows.map((r) => {
    const income = Number(r.income);
    const expense = Number(r.expense);
    return {
      businessId: r.id as number,
      businessName: r.display_name as string,
      income,
      expense,
      net: Math.round((income - expense) * 100) / 100,
      count: Number(r.cnt),
    };
  });
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
 * 删除一条收支:先取出其全部凭证相对路径(供调用方清理磁盘),
 * 再删除记录行(exp_file 由 CASCADE 一并删除)。返回受影响行数与凭证路径。
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
