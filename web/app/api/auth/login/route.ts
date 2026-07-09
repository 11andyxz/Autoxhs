import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "axs_auth";

/** 登录:密码正确则种一个 httpOnly cookie(值为密码的 SHA-256,与 middleware 校验一致)。 */
export async function POST(req: NextRequest) {
  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }
  const expected = process.env.APP_PASSWORD || "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!expected) {
    return NextResponse.json({ success: false, error: "未配置访问密码。" }, { status: 500 });
  }
  if (password !== expected) {
    return NextResponse.json({ success: false, error: "密码错误。" }, { status: 401 });
  }
  const token = createHash("sha256").update("axs:" + expected).digest("hex");
  const res = NextResponse.json({ success: true });
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 天
  });
  return res;
}
