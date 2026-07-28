import { NextResponse, type NextRequest } from "next/server";

import {
  REDNOTE_BASE,
  RednoteFailedError,
  RednoteUnreachableError,
  resolveTopics,
} from "@/lib/xiaohongshu/rednote";
import { normalizeTagNames, topicLine } from "@/lib/xiaohongshu/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 校验标签能不能变成**可点击话题**（发布前的自查，不写任何东西）。
 *
 * 为什么需要：AI 生成的标签只是些词，小红书上没有同名话题的会在发布时被丢掉
 * （宁可少一个话题，也不发一个点不动的假话题）。发之前先看一眼，比发完才发现强。
 */
export async function POST(req: NextRequest) {
  let request: { tags?: unknown };
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const names = normalizeTagNames(
    (Array.isArray(request.tags) ? request.tags : []).filter(
      (t): t is string => typeof t === "string",
    ),
  );
  if (names.length === 0) {
    return NextResponse.json({ success: false, error: "没有可校验的标签。" }, { status: 400 });
  }

  try {
    const { tags, missing } = await resolveTopics(names);
    return NextResponse.json({
      success: true,
      matched: tags.map((t) => ({ id: t.id, name: t.name })),
      missing,
      // 这几个话题最终会以这个样子写进笔记正文
      preview: topicLine(tags),
    });
  } catch (e) {
    const message =
      e instanceof RednoteFailedError
        ? e.message
        : e instanceof RednoteUnreachableError
          ? `无法连接本地 rednote 服务(${REDNOTE_BASE})，请确认它在运行且浏览器已登录。`
          : "话题校验失败，请重试。";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
