import { NextResponse, type NextRequest } from "next/server";

import { createBusiness, ensureExpenseSchema, listBusinesses } from "@/lib/expense/repo";
import { validateBusinessName } from "@/lib/expense/validate";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** business 大分类清单。 */
export async function GET() {
  try {
    await ensureExpenseSchema();
    const businesses = await listBusinesses();
    return NextResponse.json({ success: true, businesses });
  } catch (err) {
    console.error("[expense/business:list] 失败", { name: (err as Error)?.name });
    return bad("读取 business 列表失败。", 500);
  }
}

/** 新建 business(名称已存在则返回既有,created=false)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);
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
    const { id, created } = await createBusiness((body.name ?? "").trim());
    return NextResponse.json({ success: true, id, created });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_DUP_ENTRY") return bad("该 business 已存在。");
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/business:create] DB 错误", { code });
      return bad("数据库暂时不可用,请稍后重试。", 503);
    }
    console.error("[expense/business:create] 失败", { name: (err as Error)?.name });
    return bad("新建失败,请稍后重试。", 500);
  }
}
