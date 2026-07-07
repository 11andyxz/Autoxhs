/**
 * 「工作邮件自动发送」的发送记录(work record)。复用共享 MySQL 连接池,
 * 表 emp_work_email 用 employee_id 关联雇员,首次使用时幂等建表。
 * 发出去的每封工作邮件都会记一条,可在「雇员信息」的雇员详情里看到。
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { ensureEmployeeSchema } from "@/lib/employee/repo";
import { getPool } from "@/lib/serviceFee/db";

let schemaReady: Promise<void> | null = null;

/** 首次使用时建表(幂等)。失败时清空缓存以便下次重试。 */
export function ensureWorkEmailSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await ensureEmployeeSchema(); // 外键目标表,先确保存在
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS emp_work_email (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NULL,
        to_email VARCHAR(320) NOT NULL,
        recipient_name VARCHAR(255) NOT NULL DEFAULT '',
        cc TEXT NULL,
        from_email VARCHAR(320) NOT NULL,
        subject VARCHAR(500) NOT NULL,
        body MEDIUMTEXT NOT NULL,
        message_id VARCHAR(500) NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_wemail_emp (employee_id),
        CONSTRAINT fk_wemail_emp FOREIGN KEY (employee_id)
          REFERENCES emp_employee(id) ON DELETE SET NULL
      )
    `);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

export interface NewWorkEmail {
  employeeId: number | null;
  toEmail: string;
  recipientName: string;
  cc: string[];
  fromEmail: string;
  subject: string;
  body: string;
  messageId: string | null;
}

/** 插入一条工作邮件发送记录,返回新记录 id。 */
export async function insertWorkEmailLog(rec: NewWorkEmail): Promise<number> {
  await ensureWorkEmailSchema();
  const p = getPool();
  const [res] = await p.query<ResultSetHeader>(
    `INSERT INTO emp_work_email
       (employee_id, to_email, recipient_name, cc, from_email, subject, body, message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.employeeId,
      rec.toEmail,
      rec.recipientName,
      rec.cc.join(", "),
      rec.fromEmail,
      rec.subject,
      rec.body,
      rec.messageId,
    ],
  );
  return res.insertId;
}

export interface WorkEmailLogItem {
  id: number;
  subject: string;
  toEmail: string;
  recipientName: string;
  cc: string[];
  fromEmail: string;
  body: string;
  sentAt: string;
}

function splitCc(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按 employee_id 分组返回全部工作邮件记录(供雇员详情展示,按发送时间倒序)。 */
export async function listWorkEmailsByEmployee(): Promise<Map<number, WorkEmailLogItem[]>> {
  await ensureWorkEmailSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, employee_id, to_email, recipient_name, cc, from_email, subject, body, sent_at
       FROM emp_work_email
      WHERE employee_id IS NOT NULL
      ORDER BY sent_at DESC, id DESC`,
  );
  const map = new Map<number, WorkEmailLogItem[]>();
  for (const r of rows) {
    const empId = r.employee_id as number;
    const list = map.get(empId) ?? [];
    list.push({
      id: r.id as number,
      subject: r.subject as string,
      toEmail: r.to_email as string,
      recipientName: (r.recipient_name as string) ?? "",
      cc: splitCc(r.cc as string | null),
      fromEmail: r.from_email as string,
      body: r.body as string,
      sentAt: r.sent_at as string,
    });
    map.set(empId, list);
  }
  return map;
}
