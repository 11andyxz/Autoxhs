import { type NextRequest, NextResponse } from "next/server";

import { answerFromMyProjects } from "@/lib/job-hunter/interview/ai";
import { type CodeContext, collectCodeContext } from "@/lib/job-hunter/interview/codeContext";
import { getCramCard, getCramSession, setCramCardProjectAnswer } from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import {
  MAX_PROJECT_ANSWER,
  cleanProjectAnswer,
  clipResumeForPrompt,
  hasUsableResume,
  normalizePreferredProject,
  projectAnswerInputs,
  resumeTextFromHtml,
} from "@/lib/job-hunter/interview/projectAnswer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 一张问答卡的「结合我的项目」回答:同一道题,按这份简历里的项目再答一遍。
 * 原答案(content)一字不动,这份另存 project_answer,复习时显示在原答案下面。
 *
 * POST   {cardId}                → 生成并落库(已有就覆盖 = 重新生成),返回 {projectAnswer}
 * PUT    {cardId, projectAnswer} → 存用户手改的版本
 * DELETE ?id=                    → 清掉这份(原答案不受影响)
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { cardId?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const cardId = Number(body.cardId);
  if (!Number.isInteger(cardId) || cardId <= 0) return bad("缺少卡片 id。");

  try {
    const card = await getCramCard(cardId);
    if (!card) return bad("这张卡不存在。", 404);
    if (card.kind === "svg") return bad("记忆图卡不支持结合项目回答。");
    const inputs = projectAnswerInputs(card);
    if (!inputs) return bad("这张卡没有可用的题面和答案。");

    const session = await getCramSession(card.session_id);
    if (!session) return bad("这份简历不存在。", 404);
    const resumeText = clipResumeForPrompt(resumeTextFromHtml(session.resume_html));
    if (!hasUsableResume(resumeText)) {
      return bad("这份简历里没有可用的正文，先上传/追加简历内容再结合项目回答。");
    }

    // 代码佐证:从这份简历配的本机代码库里挑几段真代码。挑不到 / 读不了都不算失败 ——
    // 少了代码块的回答仍然有用,为它整条接口报错才是本末倒置。
    let code: CodeContext | null = null;
    if (session.code_path) {
      try {
        code = await collectCodeContext(session.code_path, `${inputs.question}\n${inputs.baseAnswer}`);
      } catch (err) {
        console.warn("[interview:cram-project-answer] 读代码库失败", {
          name: (err as { name?: string } | null)?.name ?? "Unknown",
        });
      }
    }

    const answer = cleanProjectAnswer(
      await answerFromMyProjects({
        ...inputs,
        resumeText,
        // 这份简历的「默认项目」(在猛攻页头部设):答得上就用它讲,答不上模型自己挑。
        preferProject: normalizePreferredProject(session.preferred_project),
        codeTree: code?.tree,
        codeExcerpts: code?.excerpts,
      }),
    );
    if (!answer) return bad("生成的简历版回答是空的，请重试。", 502);
    await setCramCardProjectAnswer(cardId, answer);
    return NextResponse.json({ success: true, projectAnswer: answer });
  } catch (err) {
    return fail(err, "cram-project-answer");
  }
}

export async function PUT(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { cardId?: unknown; projectAnswer?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const cardId = Number(body.cardId);
  if (!Number.isInteger(cardId) || cardId <= 0) return bad("缺少卡片 id。");
  if (typeof body.projectAnswer !== "string") return bad("没有要保存的内容。");
  const text = body.projectAnswer.trim();
  if (text.length > MAX_PROJECT_ANSWER) return bad("这段太长了，请精简一点。");

  try {
    const card = await getCramCard(cardId);
    if (!card) return bad("这张卡不存在。", 404);
    await setCramCardProjectAnswer(cardId, text);
    return NextResponse.json({ success: true, projectAnswer: text });
  } catch (err) {
    return fail(err, "cram-project-answer-save");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少卡片 id。");
  try {
    await setCramCardProjectAnswer(id, null);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "cram-project-answer-del");
  }
}
