import { type NextRequest, NextResponse } from "next/server";

import { embedTexts } from "@/lib/job-hunter/interview/ai";
import { chunkText } from "@/lib/job-hunter/interview/helpers";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { deleteKbDoc, insertKbDoc, listKbDocs } from "@/lib/job-hunter/interview/repo";
import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 200_000; // 单个知识库文档上限(字符)
const EMBED_BATCH = 96;

export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    return NextResponse.json({ success: true, docs: await listKbDocs() });
  } catch (err) {
    return fail(err, "kb-list");
  }
}

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("请求格式有误。");
  }

  let title = "";
  let text = "";
  try {
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return bad("文件过大,请控制在 5MB 以内。");
      title = file.name;
      text = await extractTextFromFile(file);
    } else {
      text = (typeof form.get("text") === "string" ? (form.get("text") as string) : "").trim();
      const t = form.get("title");
      title = (typeof t === "string" && t.trim()) || "粘贴文本";
    }
  } catch (err) {
    if (err instanceof FileParseError) return bad(err.message);
    return fail(err, "kb-parse");
  }

  if (!text) return bad("请提供要加入知识库的内容(上传文件或粘贴文本)。");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  const chunks = chunkText(text);
  if (!chunks.length) return bad("没有可索引的内容。");

  try {
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      embeddings.push(...(await embedTexts(batch)));
    }
    const docId = await insertKbDoc(
      title.slice(0, 250),
      text.length,
      chunks.map((c, i) => ({ text: c, embedding: embeddings[i] ?? [] })),
    );
    return NextResponse.json({ success: true, docId, chunkCount: chunks.length });
  } catch (err) {
    return fail(err, "kb-upload");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少文档 id。");
  try {
    await deleteKbDoc(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "kb-delete");
  }
}
