import { type NextRequest, NextResponse } from "next/server";

import { generateMockProblem } from "@/lib/job-hunter/interview/ai";
import {
  addCodingProblemGetId,
  getCodingProblem,
  listCodingProblems,
  listCodingTitles,
} from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { formatKeyPoints, formatProblemEn, formatProblemZh, speechForProblem } from "@/lib/job-hunter/interview/mockInterview";
import { MOCK_LANG_VALUES, type MockLang } from "@/lib/job-hunter/interview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

/**
 * 不等 AI:直接从题库里挑一道算法题开面试。
 * AI 出题偶尔会卡满 100 秒然后超时(实测遇到过一次),这条路是即时的,也能拿老题反复练。
 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const rows = await listCodingProblems("algorithm");
    if (!rows.length) return bad("题库里还没有算法题，先让 AI 出一道。", 404);
    // 先挑今天到期的(跟打那套 FSRS 排的),没有就随便来一道。
    const pool = rows.filter((r) => r.is_due === 1);
    const from = pool.length ? pool : rows;
    const r = from[Math.floor(Math.random() * from.length)];
    const promptEn = r.prompt_en || r.prompt;
    const setup = (r.setup ?? "").trim();
    // 题库老题的 setup 是「给定上下文」的散文(如「int[] nums 已升序排好」),不是代码骨架 ——
    // 把它并进题面,编辑器留空让人自己从零写。
    return NextResponse.json({
      success: true,
      problem: {
        id: r.id,
        title: r.title,
        titleZh: r.title,
        difficulty: r.difficulty,
        lang: r.lang,
        promptZh: setup ? `${r.prompt}\n\n给定：${setup}` : r.prompt,
        promptEn: setup ? `${promptEn}\n\nGiven: ${setup}` : promptEn,
        starterCode: "",
        topics: [],
        // 念题只念题面第一段:题库里的老题没有拆开的示例字段。
        speech: promptEn.split("\n\n")[0],
      },
    });
  } catch (err) {
    return fail(err, "mock-problem-pick");
  }
}

/**
 * 面试模式:现出一道 LeetCode 式算法题。
 * 题目同时落进 ip_coding_problem(category='algorithm'),所以面完还能拿去跟打训练;
 * 撞上同名老题就复用那一条,不会在题库里堆副本。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { lang?: unknown; difficulty?: unknown; topics?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const lang: MockLang = (MOCK_LANG_VALUES as readonly string[]).includes(body.lang as string)
    ? (body.lang as MockLang)
    : "java";
  const difficulty = (DIFFICULTIES as readonly string[]).includes(body.difficulty as string)
    ? (body.difficulty as string)
    : "medium";
  const topics = typeof body.topics === "string" ? body.topics.trim().slice(0, 200) : "";

  try {
    // 别出重复的:把题库里算法类的标题都告诉它。
    const avoidTitles = await listCodingTitles("algorithm");
    const gen = await generateMockProblem({ lang, difficulty, topics, avoidTitles: avoidTitles.slice(0, 200) });

    const { id } = await addCodingProblemGetId({
      category: "algorithm",
      lang,
      title: gen.titleZh || gen.title,
      prompt: formatProblemZh(gen),
      promptEn: formatProblemEn(gen),
      setup: gen.starterCode,
      solution: gen.solution,
      explanation: formatKeyPoints(gen),
      difficulty: gen.difficulty,
      source: "ai",
    });
    // 复用老题的情况下,库里那份才是准的(用户可能改过题干),按库里的返回。
    const saved = await getCodingProblem(id);

    return NextResponse.json({
      success: true,
      problem: {
        id,
        title: gen.title,
        titleZh: saved?.title || gen.titleZh,
        difficulty: saved?.difficulty ?? gen.difficulty,
        lang,
        promptZh: saved?.prompt || formatProblemZh(gen),
        promptEn: saved?.prompt_en || formatProblemEn(gen),
        starterCode: saved?.setup || gen.starterCode,
        topics: gen.topics,
        speech: speechForProblem(gen),
      },
    });
  } catch (err) {
    return fail(err, "mock-problem");
  }
}
