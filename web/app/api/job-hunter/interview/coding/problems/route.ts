import { type NextRequest, NextResponse } from "next/server";

import { codingCounts, isCodingCategory, listCodingProblems, toCodingView } from "@/lib/job-hunter/interview/coding";
import { fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Coding 跟打题列表(可按分类筛)+ 各分类的题量/待练量。only=counts 时只要角标,不带题目正文。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const raw = req.nextUrl.searchParams.get("category") || "";
  const category = isCodingCategory(raw) ? raw : undefined;
  try {
    if (req.nextUrl.searchParams.get("only") === "counts") {
      const counts = await codingCounts();
      return NextResponse.json({ success: true, problems: [], counts });
    }
    const [rows, counts] = await Promise.all([listCodingProblems(category), codingCounts()]);
    return NextResponse.json({ success: true, problems: rows.map(toCodingView), counts });
  } catch (err) {
    return fail(err, "coding-problems");
  }
}
