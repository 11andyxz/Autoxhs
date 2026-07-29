import { type NextRequest, NextResponse } from "next/server";

import { generateCodingProblems } from "@/lib/job-hunter/interview/ai";
import {
  CODING_CATEGORIES,
  addCodingProblems,
  codingCounts,
  isCodingCategory,
  listCodingTitles,
  type CodingCategory,
} from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DIFFICULTIES = ["mixed", "easy", "medium", "hard"] as const;
const MAX_COUNT = 10;

/**
 * AI 出一批新的跟打题。
 * categories 不传 = 混合出题(Java Lambda / MySQL / MongoDB 为主,偶尔来一道算法题)。
 * 入库按标题去重,所以重复出到同一道题不会污染题库。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { categories?: unknown; count?: unknown; difficulty?: unknown; focus?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const picked = Array.isArray(body.categories) ? body.categories.filter(isCodingCategory) : [];
  const categories: CodingCategory[] = picked.length ? Array.from(new Set(picked)) : [...CODING_CATEGORIES];
  const count = Math.max(1, Math.min(MAX_COUNT, Math.round(Number(body.count)) || 6));
  const difficulty = DIFFICULTIES.includes(body.difficulty as (typeof DIFFICULTIES)[number])
    ? (body.difficulty as string)
    : "mixed";
  const focus = typeof body.focus === "string" ? body.focus.trim().slice(0, 300) : "";

  // 混合出题时点明配比:算法题只是「偶尔来一道」,主力还是 Lambda / SQL / Mongo / 程序设计。
  const mixed = categories.length > 1;
  const categorySpec = mixed
    ? `${categories.join(", ")} — mix them; keep "algorithm" to at most 1 of ${count}, the rest split across the others`
    : categories[0];

  try {
    const existingTitles = await listCodingTitles(mixed ? undefined : categories[0]);
    const gen = await generateCodingProblems({
      categories: [categorySpec],
      count,
      difficulty,
      focus,
      existingTitles,
    });
    const added = await addCodingProblems(
      gen.problems.map((p) => ({
        category: p.category,
        lang: p.lang,
        title: p.title,
        prompt: p.prompt,
        promptEn: p.promptEn,
        setup: p.setup,
        solution: p.solution,
        explanation: p.explanation,
        difficulty: p.difficulty,
        source: "ai" as const,
      })),
    );
    const counts = await codingCounts();
    return NextResponse.json({ success: true, added, generated: gen.problems.length, counts });
  } catch (err) {
    return fail(err, "coding-generate");
  }
}
