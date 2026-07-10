import { type NextRequest, NextResponse } from "next/server";

import { generateVocabExample } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getVocab, updateVocabExample } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 换个例句 / 修复中英混杂的旧例句:重新生成【纯英文】例句,不动复习进度。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少单词 id。");

  try {
    const row = await getVocab(id);
    if (!row) return bad("单词不存在。", 404);

    // 用已存的英文读法(可能为空,提示词会据中文释义推断);旧例句当作场景提示(输出强制全英文)。
    const gen = await generateVocabExample(row.term, row.en, row.zh, row.example);
    const enOut = row.en.trim() || gen.en;
    await updateVocabExample(id, enOut, gen.example, gen.exampleZh);
    return NextResponse.json({ success: true, id, en: enOut, example: gen.example, exampleZh: gen.exampleZh });
  } catch (err) {
    return fail(err, "vocab-regenerate");
  }
}
