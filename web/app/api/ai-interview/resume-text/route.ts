import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { LIMITS } from "@/lib/aiInterview/schema";
import { FileParseError, extractTextFromFile } from "@/lib/job-hunter/parse";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 与 /api/job-hunter/default-resume 同一份文件(不放 public/,那份带手机号邮箱) */
const DEFAULT_RESUME = "Andy_Xiong_Senior_Backend_Java_Developer.docx";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

    const buf = await readFile(
      path.join(process.cwd(), "assets", "default-resume", DEFAULT_RESUME),
    ).catch(() => null);
    if (!buf) return bad("没有默认简历,请手动上传。", 404);

    const file = new File([new Uint8Array(buf)], DEFAULT_RESUME, { type: DOCX_MIME });
    const text = await extractTextFromFile(file);
    return NextResponse.json({
      success: true,
      text: text.slice(0, LIMITS.resume),
      name: DEFAULT_RESUME,
    });
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return fail(err, "ai-interview/resume-text");
  }
}
