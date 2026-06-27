import { NextResponse, type NextRequest } from "next/server";

import { I983ParseError, parseI983 } from "@/lib/employee/i983";
import { fileExtension, MAX_FILE_BYTES } from "@/lib/employee/validate";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 接收单个 I-983 PDF,抽取雇员(学生)信息供前端自动填表。仅解析、不落盘、不写库。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + 1024 * 1024) {
    return bad("文件过大,请控制在 20MB 以内。", 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return bad("请提供 I-983 PDF 文件。");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad("文件过大,请控制在 20MB 以内。", 413);
  }
  if (fileExtension(file.name) !== "pdf" && file.type !== "application/pdf") {
    return bad("仅支持 PDF 文件。");
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await parseI983(buf);
    return NextResponse.json({ success: true, recognized: result.recognized, data: result.data });
  } catch (err) {
    if (err instanceof I983ParseError) return bad(err.message);
    console.error("[employee/parse-i983] 失败", { name: (err as Error)?.name });
    return bad("解析失败,请稍后重试。", 500);
  }
}
