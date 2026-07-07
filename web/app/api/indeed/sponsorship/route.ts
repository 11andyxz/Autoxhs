import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  rateLimitedResponse,
  transportErrorResponse,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ServiceSponsorshipQuestion = {
  id?: unknown;
  label?: unknown;
  options?: unknown;
};

function normalizeSponsorshipQuestions(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const x = (item ?? {}) as ServiceSponsorshipQuestion;
    const options = Array.isArray(x.options)
      ? (x.options as Array<Record<string, unknown>>).map((o) => ({
          value: typeof o.value === "string" ? o.value : String(o.value ?? ""),
          label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
        }))
      : null;
    return {
      id: typeof x.id === "string" ? x.id : "",
      label: typeof x.label === "string" ? x.label : "",
      options,
    };
  });
}

function strArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
}

/**
 * GET /api/indeed/sponsorship?jk=&questions= —— 转发 GET /indeed/sponsorship。
 * 判断某岗位的 visa sponsorship 立场（no_sponsorship / sponsors / unknown）+ 证据。
 * questions=1 会额外拉雇主筛选题作强证据（会开草稿，稍慢）。文本启发式判定，非法律结论。
 */
export async function GET(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const jk = (searchParams.get("jk") ?? "").trim();
  if (!jk) {
    return NextResponse.json({ success: false, error: "缺少岗位 jk。" }, { status: 400 });
  }
  const questions = searchParams.get("questions") === "1" ? "1" : undefined;

  const result = await callIndeed("/indeed/sponsorship", {
    query: { jk, questions },
    timeoutMs: questions ? 60_000 : 40_000,
  });
  if (result.kind !== "ok") return transportErrorResponse(result, "判定担保立场超时，请重试。");

  const json = result.json;
  if (!json.ok) {
    return NextResponse.json(
      { success: false, error: extractServiceError(json) || "无法判定该岗位的担保立场。" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      jk: typeof json.jk === "string" ? json.jk : jk,
      sponsorship: typeof json.sponsorship === "string" ? json.sponsorship : "unknown",
      evidenceNeg: strArray(json.evidence_neg),
      evidencePos: strArray(json.evidence_pos),
      sponsorshipQuestions: normalizeSponsorshipQuestions(json.sponsorship_questions),
      note: typeof json.note === "string" ? json.note : "",
    },
  });
}
