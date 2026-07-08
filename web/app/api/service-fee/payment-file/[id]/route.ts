import { promises as fs } from "node:fs";

import { NextResponse, type NextRequest } from "next/server";

import { ensureSchema } from "@/lib/serviceFee/db";
import { getPaymentFileById, resolveStoredFile } from "@/lib/serviceFee/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 下载/预览收费记录的付款凭证。默认附件下载;?inline=1 时内嵌(PDF/图片预览)。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const fileId = Number((await params).id);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ success: false, error: "无效的文件 ID。" }, { status: 400 });
  }

  try {
    await ensureSchema();
    const rec = await getPaymentFileById(fileId);
    if (!rec) return NextResponse.json({ success: false, error: "凭证不存在。" }, { status: 404 });

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
    console.error("[service-fee/payment-file] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "下载失败,请稍后重试。" }, { status: 500 });
  }
}
