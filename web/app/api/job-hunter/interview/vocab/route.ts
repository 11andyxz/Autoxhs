import { type NextRequest, NextResponse } from "next/server";

import { generateVocabExample } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { addVocab, deleteVocab, getVocabCounts, listVocab } from "@/lib/job-hunter/interview/repo";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TERM = 120;
const MAX_CONTEXT = 1500;

/** 单词本列表 + 计数(遗忘曲线复习用)。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const [rows, counts] = await Promise.all([listVocab(), getVocabCounts()]);
    const words = rows.map((w) => ({
      id: w.id,
      term: w.term,
      ipa: w.ipa,
      zh: w.zh,
      note: w.note,
      example: w.example,
      exampleZh: w.example_zh,
      state: srState({ reviewed: w.last_reviewed_at != null, interval_days: w.interval_days }),
      isDue: w.is_due === 1,
      dueAt: w.due_at,
      lastGrade: w.last_grade,
    }));
    return NextResponse.json({ success: true, words, counts });
  } catch (err) {
    return fail(err, "vocab-list");
  }
}

/** 加入单词本:生成 tech/面试例句 → 存库(按词去重,保留已有复习进度)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { term?: unknown; ipa?: unknown; zh?: unknown; note?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const term = typeof body.term === "string" ? body.term.trim() : "";
  if (!term) return bad("没有要加入的单词。");
  if (term.length > MAX_TERM) return bad("请选择单个词或短语。");
  const ipa = typeof body.ipa === "string" ? body.ipa : "";
  const zh = typeof body.zh === "string" ? body.zh : "";
  const note = typeof body.note === "string" ? body.note : "";
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT) : "";

  try {
    const { example, exampleZh } = await generateVocabExample(term, zh, context);
    const { id, existed } = await addVocab({ term, ipa, zh, note, example, exampleZh });
    return NextResponse.json({ success: true, id, existed, example, exampleZh });
  } catch (err) {
    return fail(err, "vocab-add");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少单词 id。");
  try {
    await deleteVocab(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "vocab-delete");
  }
}
