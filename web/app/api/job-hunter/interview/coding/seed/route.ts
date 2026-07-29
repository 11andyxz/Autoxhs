import { type NextRequest, NextResponse } from "next/server";

import { addCodingProblems, codingCounts, fillMissingEnglish } from "@/lib/job-hunter/interview/coding";
import { CODING_SEED } from "@/lib/job-hunter/interview/codingSeed";
import { fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 一键导入内置经典题库(按标题去重,重复点不会产生副本)。
 * 顺带给「早就导入过、但还没有英文题干」的老题补上英文 —— 只填空,不覆盖已有内容和练习进度。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const added = await addCodingProblems(CODING_SEED);
    const filledEnglish = await fillMissingEnglish(CODING_SEED);
    const counts = await codingCounts();
    return NextResponse.json({ success: true, added, filledEnglish, seedTotal: CODING_SEED.length, counts });
  } catch (err) {
    return fail(err, "coding-seed");
  }
}
