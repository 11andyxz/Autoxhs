import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { listBankSessions } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 所有题库(按人名/简历标题),给「面试复习」入口列出可复习的题库。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    return NextResponse.json({ success: true, banks: await listBankSessions() });
  } catch (err) {
    return fail(err, "banks");
  }
}
