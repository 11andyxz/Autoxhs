import { type NextRequest, NextResponse } from "next/server";

import { deleteMockInterview, listMockInterviews } from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import type { ProbeTurn } from "@/lib/job-hunter/interview/mockInterview";
import type { MockReview } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // 存档坏了不至于让整页 500
  }
}

/** 面试模式:历史面试记录(最近 20 场)。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const rows = await listMockInterviews(20);
    const items = rows.map((r) => ({
      id: r.id,
      problemId: r.problem_id,
      title: r.title,
      lang: r.lang,
      code: r.code,
      turns: parse<ProbeTurn[]>(r.turns_json, []),
      review: parse<MockReview | null>(r.review_json, null),
      verdict: r.verdict ?? "",
      durationSec: r.duration_sec,
      createdAt: r.created_at,
    }));
    return NextResponse.json({ success: true, items });
  } catch (err) {
    return fail(err, "mock-sessions");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少记录 id。");
  try {
    await deleteMockInterview(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "mock-session-del");
  }
}
