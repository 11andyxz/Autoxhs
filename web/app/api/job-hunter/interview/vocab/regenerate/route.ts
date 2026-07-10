import { type NextRequest, NextResponse } from "next/server";

import { generateVocabDemo, generateVocabExample } from "@/lib/job-hunter/interview/ai";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { getVocab, updateVocabDemo, updateVocabExample } from "@/lib/job-hunter/interview/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 换个例子(默认:整卡重生成纯英文例句 + 例子,不动复习进度)。
 * {demoOnly:true} 则只补/换「例子」(demo),保留原例句——给旧词回填用。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: { id?: unknown; demoOnly?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少单词 id。");
  const demoOnly = body.demoOnly === true;

  try {
    const row = await getVocab(id);
    if (!row) return bad("单词不存在。", 404);

    if (demoOnly) {
      const d = await generateVocabDemo(row.term, row.en, row.zh, row.example);
      await updateVocabDemo(id, d.demo, d.demoNote);
      return NextResponse.json({ success: true, id, demo: d.demo, demoNote: d.demoNote });
    }

    // 用已存的英文读法(可能为空,提示词会据中文释义推断);旧例句当作场景提示(输出强制全英文)。
    const gen = await generateVocabExample(row.term, row.en, row.zh, row.example);
    const enOut = row.en.trim() || gen.en;
    await updateVocabExample(id, enOut, gen.example, gen.exampleZh, gen.demo, gen.demoNote);
    return NextResponse.json({
      success: true,
      id,
      en: enOut,
      example: gen.example,
      exampleZh: gen.exampleZh,
      demo: gen.demo,
      demoNote: gen.demoNote,
    });
  } catch (err) {
    return fail(err, "vocab-regenerate");
  }
}
