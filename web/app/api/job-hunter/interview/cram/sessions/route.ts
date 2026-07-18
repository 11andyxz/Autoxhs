import { type NextRequest, NextResponse } from "next/server";

import { listCramSessions } from "@/lib/job-hunter/interview/cram";
import { fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 「对应简历猛攻版」的简历列表(复习中心卡片 + 猛攻页选择用),带卡片总数/待复习数。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const sessions = await listCramSessions();
    return NextResponse.json({ success: true, sessions });
  } catch (err) {
    return fail(err, "cram-sessions");
  }
}
