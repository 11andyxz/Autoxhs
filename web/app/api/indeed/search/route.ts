import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  rateLimitedResponse,
  transportErrorResponse,
  type ServiceJson,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 30;

type ServiceJob = {
  jk?: unknown;
  title?: unknown;
  company?: unknown;
  location?: unknown;
  indeedApply?: unknown;
};

function normalizeJob(raw: ServiceJob) {
  return {
    jk: typeof raw.jk === "string" ? raw.jk : "",
    title: typeof raw.title === "string" ? raw.title : "",
    company: typeof raw.company === "string" ? raw.company : "",
    location: typeof raw.location === "string" ? raw.location : "",
    indeedApply: raw.indeedApply === true,
  };
}

/**
 * GET /api/indeed/search?q=&l=&limit= —— 转发 GET /indeed/search 搜岗位。
 * q 必填；l(地点)可空；limit 默认 10、上限 30。只有 indeedApply=true 的岗位能一键投递。
 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const l = (searchParams.get("l") ?? "").trim();
  // 缺省/空串视为「未提供」→ 默认 10（注意 Number(null)/Number("") 都是 0，会被 clamp 成 1，故先判空）。
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null || rawLimitParam.trim() === "" ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.round(rawLimit)))
    : 10;

  if (!q) {
    return NextResponse.json({ success: false, error: "请输入搜索词。" }, { status: 400 });
  }

  const result = await callIndeed("/indeed/search", {
    query: { q, l: l || undefined, limit },
    timeoutMs: 40_000,
  });
  if (result.kind !== "ok") return transportErrorResponse(result, "搜索超时，请重试。");

  const json: ServiceJson = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "搜索失败，请稍后重试。" },
      { status: 502 },
    );
  }

  const jobs = Array.isArray(json.jobs)
    ? (json.jobs as ServiceJob[]).map(normalizeJob).filter((job) => job.jk)
    : [];
  return NextResponse.json({
    success: true,
    data: {
      q: typeof json.q === "string" ? json.q : q,
      l: typeof json.l === "string" ? json.l : l,
      count: jobs.length,
      jobs,
    },
  });
}
