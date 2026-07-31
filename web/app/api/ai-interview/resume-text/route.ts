import { NextResponse, type NextRequest } from "next/server";

import { readDefaultResume } from "@/lib/aiInterview/resumeSource";
import { LIMITS } from "@/lib/aiInterview/schema";
import { FileParseError, extractTextFromFile } from "@/lib/job-hunter/parse";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 把简历变成纯文本,供实时回答做「事实依据」。
 *  - 不带文件 → 用仓库里的默认简历(页面一进来就自动拿这份,省得每次选文件)
 *  - 带 file  → 解析上传的 PDF / DOCX
 * 只回文本,不落库(简历是 PII,这个功能不需要存)。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let form: FormData | null = null;
  try {
    form = await req.formData();
  } catch {
    form = null; // 没有 body 就是「用默认简历」
  }

  try {
    const upload = form?.get("file");
    if (upload instanceof File && upload.size > 0) {
      if (upload.size > MAX_FILE_BYTES) return bad("简历文件过大,请控制在 5MB 以内。");
      const text = await extractTextFromFile(upload);
      return NextResponse.json({
        success: true,
        text: text.slice(0, LIMITS.resume),
        name: upload.name,
      });
    }

    const fallback = await readDefaultResume();
    if (!fallback) return bad("没有默认简历,请手动上传。", 404);

    return NextResponse.json({ success: true, text: fallback.text, name: fallback.name });
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return fail(err, "ai-interview/resume-text");
  }
}
