/**
 * 收件人来源:复用「雇员信息」的 emp_employee 表(项目里唯一带邮箱的人员表)。
 * 只取下拉框需要的轻量字段(id / 姓名 / 邮箱),不连带文件等重数据。
 */
import type { RowDataPacket } from "mysql2/promise";

import { getPool } from "@/lib/serviceFee/db";
import { ensureEmployeeSchema } from "@/lib/employee/repo";

export interface Recipient {
  id: number;
  name: string;
  email: string;
}

/** 全部雇员(有邮箱的),按姓名排序,供「assign 用户」下拉框使用。 */
export async function listRecipients(): Promise<Recipient[]> {
  await ensureEmployeeSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, legal_first_name, legal_last_name, email
       FROM emp_employee
      WHERE email <> ''
      ORDER BY legal_first_name ASC, legal_last_name ASC, id ASC`,
  );
  return rows.map((r) => ({
    id: r.id as number,
    name: `${r.legal_first_name as string} ${r.legal_last_name as string}`.trim(),
    email: r.email as string,
  }));
}
