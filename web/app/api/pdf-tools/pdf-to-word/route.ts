import { NextResponse, type NextRequest } from "next/server";

import { PdfEncryptedError, pdfToDocx } from "@/lib/pdfTools/pdfToWord";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 下载文件名:去掉 .pdf 后缀并清理引号/控制字符,空则回退 converted。 */
function safeBaseName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name)
    .replace(/\.pdf$/i, "")
    .replace(/[\r\n"';]+/g, " ")
    .trim();
  return base || "converted";
}

/** 接收单个 PDF,重建文本结构后转成 .docx 返回。仅转换、不落盘、不写库。 */
export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) return bad("当前请求较多,请稍后再试。", 429);

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
    return bad("请提供 PDF 文件。");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad("文件过大,请控制在 20MB 以内。", 413);
  }
  if (fileExtension(file.name) !== "pdf" && file.type !== "application/pdf") {
    return bad("仅支持 PDF 文件。");
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const docx = await pdfToDocx(buf);
    const base = safeBaseName(file.name);
    return new NextResponse(new Uint8Array(docx), {
      status: 200,
      headers: {
        "content-type": DOCX_MIME,
        "content-disposition": `attachment; filename="converted.docx"; filename*=UTF-8''${encodeURIComponent(`${base}.docx`)}`,
      },
    });
  } catch (err) {
    if (err instanceof PdfEncryptedError) {
      return bad("PDF 已加密,请先解除密码保护。");
    }
    console.error("[pdf-tools/pdf-to-word] 失败", { name: (err as Error)?.name });
    return bad("转换失败,请稍后重试。", 500);
  }
}
