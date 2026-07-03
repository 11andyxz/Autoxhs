import { NextResponse, type NextRequest } from "next/server";

import { deleteBusinessIfEmpty, ensureExpenseSchema, renameBusiness } from "@/lib/expense/repo";
import { validateBusinessName } from "@/lib/expense/validate";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 改名。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);
  const { id } = await params;
  const businessId = parseId(id);
  if (businessId === null) return bad("无效的 business ID。");

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const nameErr = validateBusinessName(body.name ?? "");
  if (nameErr) return bad(nameErr);

  try {
    await ensureExpenseSchema();
    const { ok, conflict } = await renameBusiness(businessId, (body.name ?? "").trim());
    if (conflict) return bad("该名称已被其他 business 占用。");
    if (!ok) return bad("business 不存在。", 404);
    return NextResponse.json({ success: true });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_DUP_ENTRY") return bad("该名称已被其他 business 占用。");
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/business:rename] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/business:rename] 失败", { name: (err as Error)?.name });
    return bad("改名失败,请稍后重试。", 500);
  }
}

/** 删除 business:仅当其名下没有任何记录时允许。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);
  const { id } = await params;
  const businessId = parseId(id);
  if (businessId === null) return bad("无效的 business ID。");

  try {
    await ensureExpenseSchema();
    const { deleted, inUse } = await deleteBusinessIfEmpty(businessId);
    if (inUse) return bad("该 business 下还有记录,请先删除或转移这些记录后再删除。", 409);
    if (!deleted) return bad("business 不存在或已删除。", 404);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/business:delete] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/business:delete] 失败", { name: (err as Error)?.name });
    return bad("删除失败,请稍后重试。", 500);
  }
}
