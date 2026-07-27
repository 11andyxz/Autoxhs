import { NextResponse, type NextRequest } from "next/server";

import { rateLimit } from "@/lib/rateLimit";
import {
  dedupeAddresses,
  GmailNotConfiguredError,
  isValidEmail,
  sendWorkEmail,
} from "@/lib/workEmail/gmail";
import { insertWorkEmailLog } from "@/lib/workEmail/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;
const MAX_CC = 10;
/** 同一封信最多几个收件人(To) */
const MAX_TO = 5;
/** 收件人列表落库(", " 拼接)后的长度上限,与 emp_work_email.to_email 对齐 */
const MAX_TO_JOINED = 900;

const GENERIC_ERROR = "发送失败,请稍后重试。";
const RATE_LIMIT_ERROR = "当前请求较多,请稍后再试。";
const NOT_CONFIGURED_ERROR =
  "尚未配置发件邮箱。请在 web/.env.local 里填入 GMAIL_USER 与 GMAIL_APP_PASSWORD 后重启服务。";

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return bad(RATE_LIMIT_ERROR, 429);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const b = (payload ?? {}) as Record<string, unknown>;
  // to 支持单个字符串(旧客户端)或字符串数组(可同时发多个邮箱)
  const toRaw = Array.isArray(b.to) ? b.to : [b.to];
  const to = dedupeAddresses(toRaw.map((t) => (typeof t === "string" ? t : "")));
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const body = typeof b.body === "string" ? b.body : "";
  const ccRaw = Array.isArray(b.cc) ? b.cc : [];
  // 关联的雇员(选自数据库时才有);自定义收件人则为 null
  const employeeId =
    typeof b.employeeId === "number" && Number.isFinite(b.employeeId)
      ? Math.trunc(b.employeeId)
      : null;
  const recipientName =
    typeof b.recipientName === "string" ? b.recipientName.trim().slice(0, 200) : "";

  if (!to.length) return bad("请填写收件人邮箱。");
  if (to.length > MAX_TO) return bad(`最多同时发给 ${MAX_TO} 个收件人。`);
  for (const t of to) {
    if (!isValidEmail(t)) return bad(`收件人邮箱「${t}」格式不正确。`);
  }
  if (to.join(", ").length > MAX_TO_JOINED) return bad("收件人邮箱过长,请减少收件人。");
  if (!subject) return bad("请填写邮件主题。");
  if (subject.length > MAX_SUBJECT) return bad("邮件主题过长。");
  if (!body.trim()) return bad("邮件正文不能为空。");
  if (body.length > MAX_BODY) return bad("邮件正文过长。");

  const cc: string[] = [];
  for (const c of ccRaw) {
    const s = typeof c === "string" ? c.trim() : "";
    if (!s) continue;
    if (!isValidEmail(s)) return bad(`抄送邮箱「${s}」格式不正确。`);
    cc.push(s);
    if (cc.length > MAX_CC) return bad(`最多抄送 ${MAX_CC} 个邮箱。`);
  }

  try {
    const result = await sendWorkEmail({ to, cc, subject, body });
    // 记录为「工作邮件记录」(work record)。邮件已发出,记录失败不影响结果。
    try {
      await insertWorkEmailLog({
        employeeId,
        toEmail: result.to.join(", "),
        recipientName,
        cc: result.cc,
        fromEmail: result.from,
        subject,
        body,
        messageId: result.messageId ?? null,
      });
    } catch (logErr) {
      console.error("[work-email/send] 记录工作邮件失败", { name: (logErr as Error)?.name });
    }
    return NextResponse.json({ success: true, result }, { status: 200 });
  } catch (err) {
    if (err instanceof GmailNotConfiguredError) {
      console.error("[work-email/send] Gmail 未配置");
      return bad(NOT_CONFIGURED_ERROR, 500);
    }
    // 邮箱格式类错误(Error message 已中文化)直接回传;其余用通用文案
    const msg = (err as Error)?.message;
    if (msg && /邮箱|主题|正文/.test(msg)) {
      return bad(msg, 400);
    }
    console.error("[work-email/send] 发送失败", { name: (err as Error)?.name });
    return bad(GENERIC_ERROR, 502);
  }
}
