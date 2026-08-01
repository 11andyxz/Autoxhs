import { type NextRequest, NextResponse } from "next/server";

import { answerCardFollowup } from "@/lib/job-hunter/interview/ai";
import { type CodeContext, collectCodeContext } from "@/lib/job-hunter/interview/codeContext";
import { getCramCard, getCramSession, setCramCardFollowups } from "@/lib/job-hunter/interview/cram";
import {
  MAX_FOLLOWUP_Q,
  MAX_FOLLOWUP_SNIPPET,
  appendFollowup,
  parseFollowups,
  removeFollowup,
  serializeFollowups,
} from "@/lib/job-hunter/interview/followups";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { cleanProjectAnswer } from "@/lib/job-hunter/interview/projectAnswer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 卡片上的「就地追问」:问一句关于这张卡(常常是回答里那段代码)的问题,问答**留在这张卡里**
 * (ip_cram_card.followups_json),复习时跟着卡一起看,不另起卡片、不弹独立面板。
 *
 * POST   {cardId, question, snippet?, ref?} → 生成回答并追加,返回 {items}
 * DELETE ?cardId=&id=                       → 删掉其中一条,返回 {items}
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { cardId?: unknown; question?: unknown; snippet?: unknown; ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const cardId = Number(body.cardId);
  if (!Number.isInteger(cardId) || cardId <= 0) return bad("缺少卡片 id。");
  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_FOLLOWUP_Q) : "";
  if (!question) return bad("请输入你的问题。");
  const snippet = typeof body.snippet === "string" ? body.snippet.slice(0, MAX_FOLLOWUP_SNIPPET) : "";
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";

  try {
    const card = await getCramCard(cardId);
    if (!card) return bad("这张卡不存在。", 404);

    // 追问也吃代码库:问「这个方法在哪儿被调用」时才有真代码可依。查询词用「问题 + 圈中的代码」。
    let code: CodeContext | null = null;
    const session = await getCramSession(card.session_id);
    if (session?.code_path) {
      try {
        code = await collectCodeContext(session.code_path, `${question}\n${snippet}`);
      } catch (err) {
        console.warn("[interview:cram-card-followup] 读代码库失败", {
          name: (err as { name?: string } | null)?.name ?? "Unknown",
        });
      }
    }

    const answer = cleanProjectAnswer(
      await answerCardFollowup({
        question,
        cardQuestion: card.front ?? "",
        cardAnswer: card.content ?? "",
        projectAnswer: card.project_answer ?? "",
        snippet,
        snippetRef: ref,
        codeTree: code?.tree,
        codeExcerpts: code?.excerpts,
      }),
    );
    if (!answer) return bad("回答是空的，请重试。", 502);

    const items = appendFollowup(parseFollowups(card.followups_json), { q: question, a: answer, ref });
    await setCramCardFollowups(cardId, serializeFollowups(items));
    return NextResponse.json({ success: true, items });
  } catch (err) {
    return fail(err, "cram-card-followup");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const cardId = Number(req.nextUrl.searchParams.get("cardId"));
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(cardId) || cardId <= 0) return bad("缺少卡片 id。");
  if (!Number.isInteger(id) || id <= 0) return bad("缺少追问 id。");
  try {
    const card = await getCramCard(cardId);
    if (!card) return bad("这张卡不存在。", 404);
    const items = removeFollowup(parseFollowups(card.followups_json), id);
    await setCramCardFollowups(cardId, serializeFollowups(items));
    return NextResponse.json({ success: true, items });
  } catch (err) {
    return fail(err, "cram-card-followup-del");
  }
}
