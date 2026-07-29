import { NextResponse, type NextRequest } from "next/server";

import { createSession, listSessions } from "@/lib/aiInterview/repo";
import { LIMITS, asLang, asMode, clip } from "@/lib/aiInterview/schema";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 历史会话列表(最近 30 场) */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  try {
    const sessions = await listSessions(30);
    return NextResponse.json({ success: true, sessions });
  } catch (err) {
    return fail(err, "ai-interview/sessions:list");
  }
}

/** 开始一场面试:建会话行,返回 id;之后字幕/总结都挂在这个 id 上。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  try {
    const company = clip(body.company, LIMITS.company);
    const title = clip(body.title, LIMITS.title) || (company ? `${company} 面试` : "面试");
    const id = await createSession({
      title,
      mode: asMode(body.mode),
      lang: asLang(body.lang),
      company,
      jd: clip(body.jd, LIMITS.jd),
      notes: clip(body.notes, LIMITS.notes),
    });
    return NextResponse.json({ success: true, id, title });
  } catch (err) {
    return fail(err, "ai-interview/sessions:create");
  }
}
