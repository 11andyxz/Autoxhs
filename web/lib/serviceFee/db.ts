import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

/**
 * MySQL 连接池(仅服务器端)。配置来自 .env.local 的 DB_* 变量。
 * Aiven 要求 SSL;这里用 TLS 但暂不校验证书(rejectUnauthorized:false),
 * 如需完整校验可在后续传入 Aiven CA 证书。
 */
// 把连接池挂到 globalThis:Next.js dev 下每次 HMR 都会重新求值本模块,若用普通模块级
// 单例,`pool` 会被重置成 null → 反复新建连接池而旧池不关闭,连接持续泄漏,最终把
// Aiven 连接数打满(ER_CON_COUNT_ERROR)。挂到 global 后同一进程内始终复用同一个池。
const globalForPool = globalThis as unknown as { __autoxhsPool?: Pool };

export function getPool(): Pool {
  if (globalForPool.__autoxhsPool) return globalForPool.__autoxhsPool;
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error("数据库未配置(缺少 DB_HOST / DB_USER / DB_NAME)");
  }
  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT ? Number(DB_PORT) : 3306,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 5,
    // 空闲连接尽快归还:Aiven 连接数上限低,dev 反复重启若不关空闲连接易攒到
    // ER_CON_COUNT_ERROR(“Too many connections”)。空闲最多留 1 个、超 15s 关闭。
    maxIdle: 1,
    idleTimeout: 15000,
    dateStrings: true, // DATE 列以 'YYYY-MM-DD' 字符串返回,避免时区漂移
  });
  globalForPool.__autoxhsPool = pool;
  return pool;
}

let schemaReady: Promise<void> | null = null;

/**
 * 幂等补列:逐列判断存在性,不存在才 ALTER,并容忍 ER_DUP_FIELDNAME
 * (信息库可能滞后/并发),保证中断后重跑与多实例并发都安全 —— 不依赖单次 information_schema 结果。
 */
async function addColumnIfMissing(p: Pool, table: string, column: string, ddl: string): Promise<void> {
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;
  try {
    await p.query(ddl);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "ER_DUP_FIELDNAME") throw err;
  }
}

/** 首次使用时建表(幂等)。多次调用只执行一次。 */
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        normalized_name VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255) NOT NULL,
        actual_tax_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS fee_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        input_start_date DATE NOT NULL,
        input_end_date DATE NOT NULL,
        actual_end_date DATE NOT NULL,
        weekly_work_hours DECIMAL(10,2) NOT NULL,
        hourly_wage DECIMAL(10,2) NOT NULL,
        tax_per_payroll DECIMAL(10,2) NOT NULL,
        monthly_payroll_fee DECIMAL(10,2) NOT NULL,
        monthly_service_charge DECIMAL(10,2) NOT NULL,
        gross_wages DECIMAL(12,2) NOT NULL,
        total_tax DECIMAL(12,2) NOT NULL,
        total_payroll_fees DECIMAL(12,2) NOT NULL,
        total_service_charge DECIMAL(12,2) NOT NULL,
        grand_total DECIMAL(12,2) NOT NULL,
        result_json JSON NOT NULL,
        paid TINYINT(1) NOT NULL DEFAULT 0,
        paid_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_record (client_id, input_start_date, input_end_date, actual_end_date),
        CONSTRAINT fk_fr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS billed_payroll_months (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        record_id INT NOT NULL,
        month CHAR(7) NOT NULL,
        UNIQUE KEY uniq_pm (client_id, month),
        CONSTRAINT fk_pm_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        CONSTRAINT fk_pm_record FOREIGN KEY (record_id) REFERENCES fee_records(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS billed_service_months (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        record_id INT NOT NULL,
        month CHAR(7) NOT NULL,
        UNIQUE KEY uniq_sm (client_id, month),
        CONSTRAINT fk_sm_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        CONSTRAINT fk_sm_record FOREIGN KEY (record_id) REFERENCES fee_records(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS billed_tax_weeks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        record_id INT NOT NULL,
        week_monday DATE NOT NULL,
        UNIQUE KEY uniq_tw (client_id, week_monday),
        CONSTRAINT fk_tw_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        CONSTRAINT fk_tw_record FOREIGN KEY (record_id) REFERENCES fee_records(id) ON DELETE CASCADE
      )
    `);
    // fee_records 加 paid 状态(旧库幂等补列;逐列独立,防中断/并发)
    await addColumnIfMissing(p, "fee_records", "paid", "ALTER TABLE fee_records ADD COLUMN paid TINYINT(1) NOT NULL DEFAULT 0");
    await addColumnIfMissing(p, "fee_records", "paid_at", "ALTER TABLE fee_records ADD COLUMN paid_at DATETIME NULL");
    // clients 加「实际 tax」累计额(旧库幂等补列):客户税务余额 = 累计 Tax Withheld − 实际 tax
    await addColumnIfMissing(p, "clients", "actual_tax_paid", "ALTER TABLE clients ADD COLUMN actual_tax_paid DECIMAL(12,2) NOT NULL DEFAULT 0");
    // 收费记录的付款凭证(标记已付时上传;随记录级联删)
    await p.query(`
      CREATE TABLE IF NOT EXISTS fee_payment_file (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_id INT NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(255) NOT NULL,
        relative_path VARCHAR(700) NOT NULL,
        mime_type VARCHAR(127) NOT NULL,
        size_bytes INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_feepay_record FOREIGN KEY (record_id) REFERENCES fee_records(id) ON DELETE CASCADE
      )
    `);
  })();
  return schemaReady;
}

/** 客户名归一化:去首尾空格 + 小写(用于唯一识别) */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
