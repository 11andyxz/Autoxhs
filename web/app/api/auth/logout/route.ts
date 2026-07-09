import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 登出:清掉登录 cookie。 */
export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ success: true });
  res.cookies.set("axs_auth", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
