import { NextResponse, type NextRequest } from "next/server";

import { buildResumeDocx } from "@/lib/job-hunter/docx";
import { renderAnalysisPdf, renderCoverLetterPdf } from "@/lib/job-hunter/pdf";
import { JobHunterSchema } from "@/lib/job-hunter/schema";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// 简历 PDF 改由浏览器端「打印另存为 PDF」生成,不再走服务端;此处只导出 Word 与
// 求职信 / 分析报告 PDF。
const KINDS = ["resume-docx", "cover-pdf", "analysis-pdf"] as const;
type Kind = (typeof KINDS)[number];

// 正常导出负载远小于此;主要用于挡住「客户端可任意构造 result」带来的超大负载,
// 避免被同步渲染成 PDF/DOCX 拖垮单进程。配合 schema 的数组/字符串上限做双重兜底。
const MAX_EXPORT_BODY = 2 * 1024 * 1024; // 2MB

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 生成下载文件名(ASCII 兜底 + UTF-8 filename*),兼容含中文姓名 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename,
  )}`;
}

function slug(name: string, fallback: string): string {
  const s = name.trim().replace(/\s+/g, "_");
  return s || fallback;
}

function fileResponse(buffer: Buffer, filename: string, mime: string) {
  // 复制成 Uint8Array<ArrayBuffer>,满足 Response 的 BodyInit 类型(文件很小,拷贝开销可忽略)
  const body = new Uint8Array(buffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": contentDisposition(filename),
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return bad("当前请求较多,请稍后再试。", 429);
  }

  // 限制请求体大小:先看 Content-Length(常规情况),再按实际读到的字节兜底
  // (防止省略 Content-Length 的分块请求绕过)。
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_EXPORT_BODY) {
    return bad("导出内容过大。", 413);
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return bad("请求格式有误。");
  }
  if (raw.length > MAX_EXPORT_BODY) {
    return bad("导出内容过大。", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("请求格式有误。");
  }

  const kind = (body as { kind?: unknown })?.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) {
    return bad("不支持的导出类型。");
  }

  const parsed = JobHunterSchema.safeParse((body as { result?: unknown })?.result);
  if (!parsed.success) {
    return bad("导出内容有误,请重新生成。");
  }
  const result = parsed.data;
  const name = result.resume.name;

  try {
    switch (kind as Kind) {
      case "resume-docx": {
        const buf = await buildResumeDocx(result.resume);
        return fileResponse(buf, `Resume_${slug(name, "candidate")}.docx`, DOCX_MIME);
      }
      case "cover-pdf": {
        const buf = await renderCoverLetterPdf(
          result.coverLetter,
          result.resume.name,
          result.resume.contacts.join("  |  "),
        );
        return fileResponse(
          buf,
          `Cover_Letter_${slug(name, "candidate")}.pdf`,
          PDF_MIME,
        );
      }
      case "analysis-pdf": {
        const buf = await renderAnalysisPdf(result.analysis, name, result.language);
        return fileResponse(buf, "Match_Report.pdf", PDF_MIME);
      }
    }
  } catch (err) {
    console.error("[job-hunter] 导出失败", {
      kind,
      name: (err as { name?: string } | null)?.name ?? "Unknown",
    });
    return bad("文件生成失败,请稍后重试。", 500);
  }
}
