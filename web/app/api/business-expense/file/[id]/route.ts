import { promises as fs } from "node:fs";

import { NextResponse, type NextRequest } from "next/server";

import { deleteExpenseFileById, ensureExpenseSchema, getExpenseFileById } from "@/lib/expense/repo";
import { removeExpenseFilesByRelativePaths, resolveStoredFile } from "@/lib/expense/storage";
import { tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 返回单个凭证。默认作为附件下载(Content-Disposition: attachment);
 * 带 ?inline=1 时以 inline 返回供浏览器内嵌预览(PDF/图片)。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const { id } = await params;
  const fileId = parseId(id);
  if (fileId === null) {
    return NextResponse.json({ success: false, error: "无效的文件 ID。" }, { status: 400 });
  }

  try {
    await ensureExpenseSchema();
    const rec = await getExpenseFileById(fileId);
    if (!rec) {
      return NextResponse.json({ success: false, error: "文件不存在。" }, { status: 404 });
    }

    let absPath: string;
    try {
      absPath = resolveStoredFile(rec.relativePath);
    } catch {
      return NextResponse.json({ success: false, error: "文件路径无效。" }, { status: 400 });
    }

    let data: Buffer;
    try {
      data = await fs.readFile(absPath);
    } catch {
      return NextResponse.json({ success: false, error: "文件已丢失,无法下载。" }, { status: 404 });
    }

    const asciiName = rec.originalName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const disposition = inline ? "inline" : "attachment";
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": rec.mimeType || "application/octet-stream",
        "Content-Length": String(data.length),
        "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rec.originalName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[expense/file] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "下载失败,请稍后重试。" }, { status: 500 });
  }
}

/** 删除单个凭证(DB 行 + 磁盘文件)。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (tooMany(req)) {
    return NextResponse.json({ success: false, error: "当前请求较多,请稍后再试。" }, { status: 429 });
  }
  const { id } = await params;
  const fileId = parseId(id);
  if (fileId === null) {
    return NextResponse.json({ success: false, error: "无效的文件 ID。" }, { status: 400 });
  }

  try {
    await ensureExpenseSchema();
    const { deleted, relativePath } = await deleteExpenseFileById(fileId);
    if (!deleted || !relativePath) {
      return NextResponse.json({ success: false, error: "文件不存在或已删除。" }, { status: 404 });
    }
    await removeExpenseFilesByRelativePaths([relativePath]);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === "string" && (code.startsWith("ER_") || code === "ECONNREFUSED" || code === "PROTOCOL_CONNECTION_LOST")) {
      console.error("[expense/file:delete] DB 错误", { code });
      return NextResponse.json({ success: false, error: "数据库暂时不可用,请稍后重试。" }, { status: 503 });
    }
    console.error("[expense/file:delete] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "删除失败,请稍后重试。" }, { status: 500 });
  }
}
