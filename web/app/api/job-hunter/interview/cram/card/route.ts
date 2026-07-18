import { type NextRequest, NextResponse } from "next/server";

import { addCramCard, deleteCramCard, listCramCards, type CramCardKind } from "@/lib/job-hunter/interview/cram";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { srState } from "@/lib/job-hunter/interview/sr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS: CramCardKind[] = ["word", "block", "svg"];
const MAX_CONTENT = 8000;
const MAX_FRONT = 2000;

function parseExtra(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 某份简历下的复习卡列表(单词/知识块/记忆图卡同队列),带 SM-2 状态。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const sessionId = Number(req.nextUrl.searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少简历 id。");
  try {
    const rows = await listCramCards(sessionId);
    const items = rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      front: c.front ?? "",
      content: c.content,
      svg: c.svg ?? "",
      extra: parseExtra(c.extra_json),
      state: srState({ reviewed: c.last_reviewed_at != null, interval_days: c.interval_days }),
      isDue: c.is_due === 1,
      dueAt: c.due_at,
    }));
    return NextResponse.json({ success: true, items });
  } catch (err) {
    return fail(err, "cram-card-list");
  }
}

/** 加入一张复习卡:{sessionId, kind, front?, content?, svg?, extra?}。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: {
    sessionId?: unknown;
    kind?: unknown;
    front?: unknown;
    content?: unknown;
    svg?: unknown;
    extra?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const sessionId = Number(body.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return bad("缺少简历 id。");
  const kind = body.kind as CramCardKind;
  if (!KINDS.includes(kind)) return bad("无效的卡片类型。");

  const content = typeof body.content === "string" ? body.content.trim() : "";
  const svg = typeof body.svg === "string" ? body.svg.slice(0, 20000) : "";
  // svg 卡片可以没有正文(用 caption/空);其余必须有正文。
  if (!content && !svg) return bad("没有要加入的内容。");
  if (content.length > MAX_CONTENT) return bad("这块内容太长,请选短一点。");
  const front = typeof body.front === "string" ? body.front.trim().slice(0, MAX_FRONT) : "";
  const extra = body.extra != null && typeof body.extra === "object" ? body.extra : null;

  try {
    const id = await addCramCard({ sessionId, kind, front, content, svg, extra });
    return NextResponse.json({ success: true, id });
  } catch (err) {
    return fail(err, "cram-card-add");
  }
}

export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("缺少卡片 id。");
  try {
    await deleteCramCard(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "cram-card-del");
  }
}
