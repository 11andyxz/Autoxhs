import { NextResponse, type NextRequest } from "next/server";

import {
  deleteSession,
  endSession,
  getSession,
  renameSession,
  replaceTurns,
} from "@/lib/aiInterview/repo";
import { LIMITS, clip, parseTurns } from "@/lib/aiInterview/schema";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function sessionId(ctx: Ctx): Promise<number> {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 一场面试的完整记录(用于回看 / 导出 Markdown) */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (tooMany(req)) return rateLimited();
  const id = await sessionId(ctx);
  if (!id) return bad("会话不存在。", 404);
  try {
    const session = await getSession(id);
    if (!session) return bad("会话不存在。", 404);
    return NextResponse.json({ success: true, session });
  } catch (err) {
    return fail(err, "ai-interview/sessions:get");
  }
}

/**
 * 保存进度:turns 传整份字幕(全量覆盖,见 repo.replaceTurns 的说明);
 * 另可改标题、标记结束。面试进行中每隔一会儿存一次,断网/关页面也不丢。
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (tooMany(req)) return rateLimited();
  const id = await sessionId(ctx);
  if (!id) return bad("会话不存在。", 404);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }

  try {
    let turnCount: number | undefined;
    if (Array.isArray(body.turns)) {
      turnCount = await replaceTurns(id, parseTurns(body.turns, 2_000));
    }
    if (typeof body.title === "string" && body.title.trim()) {
      await renameSession(id, clip(body.title, LIMITS.title));
    }
    if (body.end === true) await endSession(id);
    return NextResponse.json({ success: true, turnCount });
  } catch (err) {
    return fail(err, "ai-interview/sessions:patch");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (tooMany(req)) return rateLimited();
  const id = await sessionId(ctx);
  if (!id) return bad("会话不存在。", 404);
  try {
    await deleteSession(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "ai-interview/sessions:delete");
  }
}
