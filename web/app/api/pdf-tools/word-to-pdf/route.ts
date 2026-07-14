import { NextResponse, type NextRequest } from "next/server";

import { ChromeNotFoundError, docxToPdf } from "@/lib/pdfTools/wordToPdf";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

/** 接收单个 .docx,经本机 Chrome 打印为 PDF 返回。仅转换、不落盘、不写库。 */
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
    return bad("请提供 .docx 文件。");
  }
  if (file.size > MAX_FILE_BYTES) {
    return bad("文件过大,请控制在 20MB 以内。", 413);
  }
  const ext = fileExtension(file.name);
  if (ext === "doc") {
    return bad("旧版 .doc 暂不支持,请先在 Word 里另存为 .docx。");
  }
  if (ext !== "docx" && file.type !== DOCX_MIME) {
    return bad("仅支持 .docx 文件。");
  }

  const rawPageSize = form.get("pageSize");
  let pageSize: "letter" | "a4" = "letter";
  if (typeof rawPageSize === "string" && rawPageSize !== "") {
    if (rawPageSize !== "letter" && rawPageSize !== "a4") {
      return bad("pageSize 仅支持 letter 或 a4。");
    }
    pageSize = rawPageSize;
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const pdf = await docxToPdf(buf, { pageSize });
    const base = file.name.replace(/\.[^.]*$/, "") || "converted";
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="converted.pdf"; filename*=UTF-8''${encodeURIComponent(`${base}.pdf`)}`,
      },
    });
  } catch (err) {
    if (err instanceof ChromeNotFoundError) return bad(err.message, 503);
    console.error("[pdf-tools/word-to-pdf] 失败", { name: (err as Error)?.name });
    return bad("转换失败,请稍后重试。", 500);
  }
}
