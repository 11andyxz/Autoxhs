import type { RowDataPacket } from "mysql2";

import { PROFILE_FIELDS, emptyProfile, type ApplicantProfile } from "@/lib/indeed/profileFields";
import { getPool } from "@/lib/serviceFee/db";

/**
 * 求职身份档案(单条,给 AI 作答雇主问题做「事实依据」)。
 *
 * 存的是身份/资格类硬事实(工作授权、是否需 sponsorship、公民身份、年限……),
 * AI 据此如实作答;缺的字段可后续补。与 /employee 的雇员档案是两码事,故独立建表。
 * 复用共享 MySQL 池;无鉴权、单用户,与库内其他表一致的取舍。
 * 字段定义在 lib/indeed/profileFields(纯元数据,客户端表单亦可复用)。
 */

export type { ApplicantProfile } from "@/lib/indeed/profileFields";
export { PROFILE_FIELDS, emptyProfile } from "@/lib/indeed/profileFields";

const MAX_FIELD = 1000;

/** 只保留已知字段、裁剪长度,防脏数据入库。 */
export function sanitizeProfile(raw: unknown): ApplicantProfile {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = emptyProfile();
  for (const f of PROFILE_FIELDS) {
    const v = src[f.key];
    out[f.key] = (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, MAX_FIELD).trim();
  }
  return out;
}

/** 把非空字段拼成给 AI 的「已知事实」清单。 */
export function profileFactsText(p: ApplicantProfile): string {
  const lines = PROFILE_FIELDS.map((f) => {
    const v = (p[f.key] ?? "").trim();
    return v ? `- ${f.label}: ${v}` : null;
  }).filter(Boolean);
  return lines.join("\n");
}

let schemaReady: Promise<void> | null = null;

export function ensureProfileSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS applicant_profile (
        id INT PRIMARY KEY,
        data JSON NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  })();
  return schemaReady;
}

type ProfileRow = RowDataPacket & { data: string | null };

export async function getProfile(): Promise<ApplicantProfile> {
  await ensureProfileSchema();
  const p = getPool();
  const [rows] = await p.query<ProfileRow[]>("SELECT data FROM applicant_profile WHERE id = 1 LIMIT 1");
  const raw = rows[0]?.data;
  if (!raw) return emptyProfile();
  try {
    // mysql2 可能已把 JSON 列解析为对象,也可能是字符串
    return sanitizeProfile(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return emptyProfile();
  }
}

export async function saveProfile(raw: unknown): Promise<ApplicantProfile> {
  await ensureProfileSchema();
  const clean = sanitizeProfile(raw);
  const p = getPool();
  await p.query(
    `INSERT INTO applicant_profile (id, data) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [JSON.stringify(clean)],
  );
  return clean;
}
