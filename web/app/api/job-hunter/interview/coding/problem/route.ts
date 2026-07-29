import { type NextRequest, NextResponse } from "next/server";

import {
  deleteCodingProblem,
  getCodingProblem,
  listCodingAttempts,
  toCodingView,
  updateCodingProblem,
} from "@/lib/job-hunter/interview/coding";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { normalizeCode } from "@/lib/job-hunter/interview/typing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function idOf(req: NextRequest): number {
  return Number(req.nextUrl.searchParams.get("id"));
}

/** 单题详情 + 最近的成绩记录(进步曲线)。 */
export async function GET(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = idOf(req);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少题目 id。");
  try {
    const p = await getCodingProblem(id);
    if (!p) return bad("题目不存在。", 404);
    const attempts = await listCodingAttempts(id, 10);
    return NextResponse.json({ success: true, problem: toCodingView(p), attempts });
  } catch (err) {
    return fail(err, "coding-problem-get");
  }
}

/** 就地改题(参考代码有错 / 题干想改写时用)。改完不影响已有进度。 */
export async function PATCH(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  let body: {
    id?: unknown;
    title?: unknown;
    prompt?: unknown;
    promptEn?: unknown;
    setup?: unknown;
    solution?: unknown;
    explanation?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少题目 id。");

  const patch: {
    title?: string;
    prompt?: string;
    promptEn?: string;
    setup?: string;
    solution?: string;
    explanation?: string;
  } = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.prompt === "string") patch.prompt = body.prompt.trim();
  if (typeof body.promptEn === "string") patch.promptEn = body.promptEn.trim();
  if (typeof body.setup === "string") patch.setup = body.setup.trim();
  if (typeof body.explanation === "string") patch.explanation = body.explanation.trim();
  // 参考代码是「要被逐字敲出来」的文本,存之前一律归一化(Tab→空格、中文标点→ASCII、去围栏)。
  if (typeof body.solution === "string") patch.solution = normalizeCode(body.solution);
  if (patch.title !== undefined && !patch.title) return bad("标题不能为空。");
  if (patch.solution !== undefined && !patch.solution) return bad("参考代码不能为空。");
  if (!Object.keys(patch).length) return bad("没有要改的内容。");

  try {
    const p = await getCodingProblem(id);
    if (!p) return bad("题目不存在。", 404);
    await updateCodingProblem(id, patch);
    const updated = await getCodingProblem(id);
    return NextResponse.json({ success: true, problem: updated ? toCodingView(updated) : null });
  } catch (err) {
    return fail(err, "coding-problem-patch");
  }
}

/** 删掉一道题(连同它的成绩记录,外键级联)。 */
export async function DELETE(req: NextRequest) {
  if (tooMany(req)) return rateLimited();
  const id = idOf(req);
  if (!Number.isInteger(id) || id <= 0) return bad("缺少题目 id。");
  try {
    await deleteCodingProblem(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return fail(err, "coding-problem-delete");
  }
}
