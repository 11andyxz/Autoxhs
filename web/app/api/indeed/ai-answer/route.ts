import { NextResponse, type NextRequest } from "next/server";

import { aiAnswerQuestions, type AiAnswerQuestion } from "@/lib/indeed/aiAnswer";
import { getProfile, profileFactsText } from "@/lib/indeed/profile";
import { rateLimitedResponse } from "@/lib/indeed/service";
import { MissingApiKeyError } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTIONS = 40;

function normalizeQuestions(raw: unknown): AiAnswerQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const x = (item ?? {}) as Record<string, unknown>;
      const options = Array.isArray(x.options)
        ? (x.options as Array<Record<string, unknown>>).map((o) => ({
            value: typeof o.value === "string" ? o.value : String(o.value ?? ""),
            label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
          }))
        : null;
      return {
        id: typeof x.id === "string" ? x.id : "",
        type: typeof x.type === "string" ? x.type : "",
        required: x.required === true,
        label: typeof x.label === "string" ? x.label : "",
        options,
      };
    })
    .filter((q) => q.id && q.label)
    .slice(0, MAX_QUESTIONS);
}

/**
 * POST /api/indeed/ai-answer { questions, jobTitle?, company?, resume? }
 * 用 AI 依据「求职身份档案」+ 可选简历/岗位 回答雇主问题。返回 { answers: {qid: {value, confidence}} }。
 */
export async function POST(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "请求体无效。" }, { status: 400 });
  }

  const questions = normalizeQuestions(body.questions);
  if (!questions.length) {
    return NextResponse.json({ success: true, data: { answers: {} } });
  }

  try {
    const profile = await getProfile();
    const answers = await aiAnswerQuestions(questions, {
      facts: profileFactsText(profile),
      jobTitle: typeof body.jobTitle === "string" ? body.jobTitle : undefined,
      company: typeof body.company === "string" ? body.company : undefined,
      resume: typeof body.resume === "string" ? body.resume : undefined,
    });
    return NextResponse.json({ success: true, data: { answers } });
  } catch (e) {
    if (e instanceof MissingApiKeyError) {
      return NextResponse.json(
        { success: false, error: "未配置 OPENAI_API_KEY，无法用 AI 作答。" },
        { status: 500 },
      );
    }
    return NextResponse.json({ success: false, error: "AI 作答失败，请稍后重试。" }, { status: 502 });
  }
}
