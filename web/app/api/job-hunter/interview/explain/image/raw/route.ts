import { type NextRequest, NextResponse } from "next/server";

import { rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getExplainImageB64 } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 返回某题某序号的配图 PNG 字节(库里读 base64);没有则 404。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const questionId = Number(req.nextUrl.searchParams.get("questionId"));
  const ord = Number(req.nextUrl.searchParams.get("ord"));
  if (!Number.isInteger(questionId) || questionId <= 0 || !Number.isInteger(ord) || ord < 0) {
    return new NextResponse("bad request", { status: 400 });
  }
  try {
    const b64 = await getExplainImageB64(questionId, ord);
    if (!b64) return new NextResponse("not found", { status: 404 });
    const bytes = Buffer.from(b64, "base64");
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    return new NextResponse("error", { status: 500 });
  }
}
