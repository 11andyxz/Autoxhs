import { type NextRequest, NextResponse } from "next/server";

import { translateTerm } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { vocabExists } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TERM = 120; // 只查词/短语,不翻整段
const MAX_CONTEXT = 2000;

/** 划词翻译:阅读英文题目/答案时,选中一个词/短语 → 结合上下文给出中文释义。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { text?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const term = typeof body.text === "string" ? body.text.trim() : "";
  if (!term) return bad("没有选中要翻译的内容。");
  if (term.length > MAX_TERM) return bad("请选中单个词或短语。");
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT) : "";

  try {
    // 顺带查一下是否已在单词本(失败不影响翻译)。
    const [{ en, ipa, zh, note }, inVocab] = await Promise.all([
      translateTerm(term, context),
      vocabExists(term).catch(() => false),
    ]);
    return NextResponse.json({ success: true, en, ipa, zh, note, inVocab });
  } catch (err) {
    return fail(err, "translate");
  }
}
