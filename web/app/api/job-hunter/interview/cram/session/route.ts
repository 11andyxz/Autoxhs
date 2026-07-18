import { type NextRequest, NextResponse } from "next/server";

import {
  createCramSession,
  findCramSessionByHash,
  getCramSession,
  updateCramSessionHtml,
} from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { resumeHash } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_HTML = 4_000_000;

/** 把 HTML 粗略转成纯文本(取 hash / 标题用);去脚本样式与标签、解码常见实体、压空白。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function deriveTitle(name: string, text: string): string {
  const stem = name.replace(/\.(docx|html?|htm)$/i, "").trim();
  if (stem) return stem.slice(0, 120);
  const first = text.split(/[\n。.]/).map((s) => s.trim()).find(Boolean);
  return (first || "我的简历").slice(0, 120);
}

/** 上传一份简历/面试稿(客户端已转好 HTML):按归一化文本去重,返回 session。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { resumeHtml?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const resumeHtml = typeof body.resumeHtml === "string" ? body.resumeHtml : "";
  if (!resumeHtml.trim()) return bad("没有可用的简历内容。");
  if (resumeHtml.length > MAX_HTML) return bad("这份文档太大了,请精简后再上传。");
  const name = typeof body.name === "string" ? body.name : "";

  const text = htmlToText(resumeHtml);
  if (!text) return bad("这份文档看起来没有文字内容。");
  const hash = resumeHash(text);
  const title = deriveTitle(name, text);

  try {
    // 幂等:同一份简历再上传命中同一 session(不重复建、不打乱已有卡片进度)。
    const existing = await findCramSessionByHash(hash);
    if (existing) {
      return NextResponse.json({ success: true, sessionId: existing.id, title: existing.title, reused: true });
    }
    try {
      const id = await createCramSession({ title, language: "English", resumeHash: hash, resumeHtml });
      return NextResponse.json({ success: true, sessionId: id, title, reused: false });
    } catch (err) {
      // 并发同哈希:唯一键冲突时改用已存在的那条。
      if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
        const raced = await findCramSessionByHash(hash);
        if (raced) return NextResponse.json({ success: true, sessionId: raced.id, title: raced.title, reused: true });
      }
      throw err;
    }
  } catch (err) {
    return fail(err, "cram-session-create");
  }
}

/** 追加复习资料:把并好的整份 HTML 写回同一 session(客户端已合并 head 样式 + body)。 */
export async function PUT(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: { id?: unknown; resumeHtml?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少简历 id。");
  const resumeHtml = typeof body.resumeHtml === "string" ? body.resumeHtml : "";
  if (!resumeHtml.trim()) return bad("没有可用的内容。");
  if (resumeHtml.length > MAX_HTML) return bad("内容太多了,请精简后再追加。");
  try {
    const s = await getCramSession(id);
    if (!s) return bad("这份简历不存在。", 404);
    await updateCramSessionHtml(id, resumeHtml);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "cram-session-update");
  }
}

/** 取一份简历的内容(阅读/划词用)。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少简历 id。");
  try {
    const s = await getCramSession(id);
    if (!s) return bad("这份简历不存在。", 404);
    return NextResponse.json({
      success: true,
      session: {
        id: s.id,
        title: s.title,
        language: s.language,
        resumeHtml: s.resume_html,
        createdAt: s.created_at,
      },
    });
  } catch (err) {
    return fail(err, "cram-session-get");
  }
}
