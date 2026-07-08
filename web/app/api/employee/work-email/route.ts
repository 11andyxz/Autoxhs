import { NextResponse, type NextRequest } from "next/server";

import { isValidEmail } from "@/lib/workEmail/gmail";
import { insertManualWorkEmail } from "@/lib/workEmail/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;
const MAX_CC = 10;

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** datetime-local('YYYY-MM-DDTHH:MM'[:SS]) 或纯日期('YYYY-MM-DD') → 'YYYY-MM-DD HH:MM:SS'；非法返回 null。 */
function normalizeDateTime(raw: string): string | null {
  const s = raw.trim();
  const dt = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (dt) return `${dt[1]}-${dt[2]}-${dt[3]} ${dt[4]}:${dt[5]}:${dt[6] ?? "00"}`;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return `${d[1]}-${d[2]}-${d[3]} 00:00:00`;
  return null;
}

/**
 * 手动补录一条「工作邮件记录」到某个雇员名下（用于以前没经工具发送、因而未入库的邮件）。
 * 只写数据库，不真的发邮件。
 */
export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const b = (payload ?? {}) as Record<string, unknown>;

  const employeeId =
    typeof b.employeeId === "number" && Number.isFinite(b.employeeId) && b.employeeId > 0
      ? Math.trunc(b.employeeId)
      : 0;
  if (!employeeId) return bad("缺少有效的雇员。");

  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  if (!subject) return bad("请填写邮件标题。");
  if (subject.length > MAX_SUBJECT) return bad("邮件标题过长。");

  const toEmail = typeof b.toEmail === "string" ? b.toEmail.trim() : "";
  if (!isValidEmail(toEmail)) return bad("请填写有效的收件人邮箱。");

  const body = typeof b.body === "string" ? b.body : "";
  if (!body.trim()) return bad("邮件正文不能为空。");
  if (body.length > MAX_BODY) return bad("邮件正文过长。");

  const sentAtRaw = typeof b.sentAt === "string" ? b.sentAt : "";
  const sentAt = normalizeDateTime(sentAtRaw);
  if (!sentAt) return bad("请填写有效的发送时间。");

  const recipientName =
    typeof b.recipientName === "string" ? b.recipientName.trim().slice(0, 200) : "";

  const cc: string[] = [];
  const ccRaw = Array.isArray(b.cc) ? b.cc : [];
  for (const c of ccRaw) {
    const s = typeof c === "string" ? c.trim() : "";
    if (!s) continue;
    if (!isValidEmail(s)) return bad(`抄送邮箱「${s}」格式不正确。`);
    cc.push(s);
    if (cc.length > MAX_CC) return bad(`最多抄送 ${MAX_CC} 个邮箱。`);
  }

  // 补录记录默认沿用配置的发件邮箱（这些工作计划邮件即从该邮箱发出）；未配置则留空。
  const fromEmail =
    typeof b.fromEmail === "string" && b.fromEmail.trim()
      ? b.fromEmail.trim()
      : process.env.GMAIL_USER || "";

  try {
    const id = await insertManualWorkEmail({
      employeeId,
      toEmail,
      recipientName,
      cc,
      fromEmail,
      subject,
      body,
      sentAt,
    });
    return NextResponse.json({ success: true, id }, { status: 200 });
  } catch (err) {
    console.error("[employee/work-email] 补录失败", { name: (err as Error)?.name });
    // 外键失败(雇员不存在)也归到这里
    return bad("补录失败，请确认该雇员存在且数据库可用。", 500);
  }
}
