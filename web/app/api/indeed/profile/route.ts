import { NextResponse, type NextRequest } from "next/server";

import { getProfile, saveProfile } from "@/lib/indeed/profile";
import { rateLimitedResponse } from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/indeed/profile —— 读取求职身份档案(供表单回填 + AI 作答依据)。 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;
  try {
    const data = await getProfile();
    return NextResponse.json({ success: true, data });
  } catch {
    return NextResponse.json({ success: false, error: "读取身份档案失败。" }, { status: 500 });
  }
}

/** POST /api/indeed/profile { profile } —— 保存身份档案(整体覆盖,单条)。 */
export async function POST(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求体无效。" }, { status: 400 });
  }
  const profile = (body as { profile?: unknown })?.profile ?? body;
  try {
    const data = await saveProfile(profile);
    return NextResponse.json({ success: true, data });
  } catch {
    return NextResponse.json({ success: false, error: "保存身份档案失败。" }, { status: 500 });
  }
}
