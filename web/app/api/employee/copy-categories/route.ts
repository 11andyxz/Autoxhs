import { NextResponse, type NextRequest } from "next/server";

import {
  employeeExists,
  ensureEmployeeSchema,
  getCategoryKeysForEmployee,
  insertCategorySlots,
} from "@/lib/employee/repo";
import { sanitizeCategoryName } from "@/lib/employee/validate";
import { getPool } from "@/lib/serviceFee/db";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/**
 * 把「来源雇员」的分类 key(有文件的分类 ∪ 空占位)复制成「目标雇员」的空占位。
 * 只复制分类名(栏目),不复制任何文件;目标已有(不分大小写)的分类会跳过。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  let body: { sourceId?: unknown; targetId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("请求格式有误。");
  }
  const sourceId = Number(body.sourceId);
  const targetId = Number(body.targetId);
  if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
    return bad("无效的雇员 ID。");
  }
  if (sourceId === targetId) return bad("来源和目标不能是同一个人。");

  await ensureEmployeeSchema();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    if (!(await employeeExists(conn, sourceId)) || !(await employeeExists(conn, targetId))) {
      await conn.rollback();
      return bad("雇员不存在。", 404);
    }

    const sourceKeys = await getCategoryKeysForEmployee(conn, sourceId);
    const targetKeys = await getCategoryKeysForEmployee(conn, targetId);
    const targetLower = new Set(targetKeys.map((k) => k.toLowerCase()));

    // 清洗 + 去空 + 去掉目标已有的 + 自身按小写去重,保留来源原始大小写
    const seen = new Set<string>();
    const toAdd: string[] = [];
    for (const raw of sourceKeys) {
      const cat = sanitizeCategoryName(raw);
      if (!cat) continue;
      const lower = cat.toLowerCase();
      if (targetLower.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      toAdd.push(cat);
    }

    const added = await insertCategorySlots(conn, targetId, toAdd);
    await conn.commit();
    return NextResponse.json({ success: true, added, addedCategories: toAdd });
  } catch (err) {
    await conn.rollback().catch(() => {});
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[employee/copy-categories] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[employee/copy-categories] 失败", { name: (err as Error)?.name });
    return bad("复制失败,请稍后重试。", 500);
  } finally {
    conn.release();
  }
}
