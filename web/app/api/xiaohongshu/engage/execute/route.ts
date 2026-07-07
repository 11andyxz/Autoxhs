import { NextResponse, type NextRequest } from "next/server";

import { rateLimit } from "@/lib/rateLimit";
import { clampCommentLength } from "@/lib/xiaohongshu/comment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const ACTION_TIMEOUT_MS = 45_000;

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

// comment(?and_like=1) 的返回：可能是「顺带点赞」的复合信封，也可能是单发评论信封。
type CommentResult = {
  ok?: boolean;
  comment_id?: string;
  code?: number | string;
  msg?: string;
  error?: string;
  // and_like=1 时的复合结构
  post?: { ok?: boolean; comment_id?: string; code?: number | string; msg?: string; error?: string };
  like?: { ok?: boolean; skipped?: string };
};

type LikeNoteResult = { ok?: boolean; code?: number | string; msg?: string; error?: string };

async function postJson<T>(path: string, payload: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 「执行」步（真实写操作，不可撤销）：在一篇笔记下发评论、可选给自己这条评论点赞、可选给帖子点赞。
 * 单次调用、不重试（避免重复写）。前端负责串行 + 间隔 + 预览确认闸门。
 */
export async function POST(req: NextRequest) {
  // 写操作也做服务端限流(防脚本/连点造成高频写触发风控)——与只读的 comment 路由一致。
  if (!rateLimit(clientKey(req)).allowed) {
    return NextResponse.json(
      { success: false, error: "当前请求较多，请稍后再试。" },
      { status: 429 },
    );
  }

  let body: { noteId?: string; comment?: string; likeComment?: boolean; likeNote?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const noteId = (body.noteId ?? "").trim();
  const comment = clampCommentLength((body.comment ?? "").trim());
  const likeComment = body.likeComment !== false; // 默认 true（点赞自己的评论）
  const likeNote = body.likeNote !== false; // 默认 true（点赞帖子）
  if (!noteId) {
    return NextResponse.json({ success: false, error: "缺少 note_id。" }, { status: 400 });
  }
  if (!comment) {
    return NextResponse.json({ success: false, error: "评论内容为空。" }, { status: 400 });
  }

  // 1) 发评论（likeComment 时用 ?and_like=1 顺带给自己这条评论点赞）
  const commentPath = `/rednote/comment${likeComment ? "?and_like=1" : ""}`;
  const cr = await postJson<CommentResult>(commentPath, { note_id: noteId, content: comment });

  if (!cr) {
    // 没拿到响应：评论可能已写入、也可能没写入(请求丢失/超时)。发评论不可幂等，
    // 故标记 outcome=unknown，前端据此**不自动重试**，避免重复评论。
    return NextResponse.json(
      {
        success: false,
        outcome: "unknown",
        commentPosted: false,
        error: `未能确认评论是否已发布(本地 rednote 服务无响应)。请勿直接重试，先到小红书确认是否已发。`,
      },
      { status: 502 },
    );
  }

  // 兼容两种信封：复合(post/like) 或 单发(顶层 ok/comment_id)
  const commentPosted = cr.post ? cr.post.ok === true : cr.ok === true;
  const commentId = cr.post?.comment_id ?? cr.comment_id;
  const commentLiked = likeComment ? cr.like?.ok === true : false;
  const commentErr =
    cr.post?.msg || cr.post?.error || cr.msg || cr.error || undefined;

  // 2) 点赞帖子（独立动作；即使评论失败也按用户意愿尝试，各自如实回报）
  let noteLiked = false;
  let noteLikeErr: string | undefined;
  if (likeNote) {
    const lr = await postJson<LikeNoteResult>("/rednote/like-note", { note_oid: noteId });
    if (!lr) {
      noteLikeErr = "点赞帖子请求失败(本地服务无响应)。";
    } else {
      noteLiked = lr.ok === true;
      if (!noteLiked) noteLikeErr = lr.msg || lr.error || "点赞帖子失败。";
    }
  }

  // 核心动作是发评论：评论成功即视为该篇 success，点赞失败只作为附带提示。
  const softNotes: string[] = [];
  if (commentPosted && likeComment && !commentLiked) softNotes.push("给自己评论点赞未成功");
  if (likeNote && !noteLiked && noteLikeErr) softNotes.push(noteLikeErr);

  if (!commentPosted) {
    // rednote 明确返回了失败(如被风控拒绝)——评论确实没发出去，可安全重试。
    return NextResponse.json(
      {
        success: false,
        outcome: "rejected",
        commentPosted: false,
        commentLiked: false,
        noteLiked,
        error: commentErr ? `发评论被拒绝：${commentErr}` : "发评论被拒绝(可能被限流)，可稍后重试。",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    outcome: "posted",
    commentPosted: true,
    commentId: commentId ?? null,
    commentLiked,
    noteLiked,
    note: softNotes.length ? softNotes.join("；") : undefined,
  });
}
