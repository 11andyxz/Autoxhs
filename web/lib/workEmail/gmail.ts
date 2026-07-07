/**
 * 通过 Gmail 发信(仅服务器端)。使用 adxztech 的 Gmail 账号 + 应用专用密码
 * (App Password)走 Nodemailer SMTP。凭据来自 .env.local:
 *   GMAIL_USER            发件邮箱,如 andy@adxztech.com(同时用于 SMTP 登录)
 *   GMAIL_APP_PASSWORD    Google 账号的「应用专用密码」(需开启两步验证后生成)
 *   GMAIL_FROM_NAME       可选,发件人显示名,默认 "Andy Xiong"
 * 未配置时抛 GmailNotConfiguredError,路由层映射为清晰的「未配置」提示。
 */
import nodemailer from "nodemailer";

import { renderEmailHtml } from "./render";

/** Gmail 发信凭据未配置时抛出 */
export class GmailNotConfiguredError extends Error {}

// 单个纯地址:不允许逗号 / 尖括号 / 引号 / 分号 / 空白等 nodemailer 地址解析器会
// 用来切分或改写收件人的字符 —— 否则像 "foo,evil@x.com" / "n<evil@x.com>" 这类
// 值会「通过校验但被投递到另一个地址」(收件人夹带)。
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** 邮件头字段防注入:去掉换行(防 CRLF header injection),裁剪长度 */
function sanitizeHeader(s: string, max = 998): string {
  return s.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

interface GmailConfig {
  user: string;
  pass: string;
  fromName: string;
}

function getConfig(): GmailConfig {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, ""); // App Password 常带空格,去掉
  if (!user || !pass) {
    throw new GmailNotConfiguredError(
      "Gmail 未配置(缺少 GMAIL_USER / GMAIL_APP_PASSWORD)",
    );
  }
  const fromName = process.env.GMAIL_FROM_NAME?.trim() || "Andy Xiong";
  return { user, pass, fromName };
}

/** 是否已配置 Gmail 发信凭据(供前端提示,不返回任何密钥) */
export function isGmailConfigured(): boolean {
  return !!(process.env.GMAIL_USER?.trim() && process.env.GMAIL_APP_PASSWORD?.trim());
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(cfg: GmailConfig): nodemailer.Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return transporter;
}

export interface SendInput {
  to: string;
  cc?: string[];
  subject: string;
  /** markdown-lite 正文(与预览同一份);发信端渲染成 HTML,并保留纯文本兜底 */
  body: string;
}

export interface SendResult {
  messageId: string;
  from: string;
  to: string;
  cc: string[];
}

/**
 * 发送一封工作邮件。to / cc 必须是合法邮箱;subject 折成单行防头注入;
 * 正文同时发送纯文本(body 原文)与 HTML(渲染后)两部分。
 */
export async function sendWorkEmail(input: SendInput): Promise<SendResult> {
  const cfg = getConfig();

  const to = input.to.trim();
  if (!isValidEmail(to)) {
    throw new Error("收件人邮箱格式不正确。");
  }
  const cc = (input.cc ?? []).map((e) => e.trim()).filter(Boolean);
  for (const c of cc) {
    if (!isValidEmail(c)) throw new Error(`抄送邮箱「${c}」格式不正确。`);
  }

  const subject = sanitizeHeader(input.subject);
  if (!subject) throw new Error("邮件主题不能为空。");
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!body) throw new Error("邮件正文不能为空。");

  // 用「结构化地址对象」而不是拼接字符串:nodemailer 会安全编码显示名(防 from
  // 头注入),且把 to/cc 当作纯地址处理,不再按逗号/尖括号二次解析(防收件人夹带)。
  const from = `${cfg.fromName} <${cfg.user}>`;
  const tx = getTransporter(cfg);
  const info = await tx.sendMail({
    from: { name: cfg.fromName, address: cfg.user },
    to: { address: to },
    cc: cc.length ? cc.map((address) => ({ address })) : undefined,
    subject,
    text: body,
    html: renderEmailHtml(body),
  });

  return { messageId: info.messageId, from, to, cc };
}
