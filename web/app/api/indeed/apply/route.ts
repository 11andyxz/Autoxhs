import { NextResponse, type NextRequest } from "next/server";

import {
  callIndeed,
  extractServiceError,
  normalizeAnswers,
  normalizeQuestions,
  rateLimitedResponse,
  transportErrorResponse,
  type ServiceJson,
} from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DRY_RUN_TIMEOUT_MS = 90_000;
const CONFIRM_TIMEOUT_MS = 120_000;

type ApplyAnswer = { questionId: string; value: string };

type ApplyRequest = {
  jk?: string;
  confirm?: boolean;
  answers?: ApplyAnswer[];
};

/** 清洗客户端传来的答案:只保留 {questionId, value:string}。 */
function sanitizeAnswers(raw: unknown): ApplyAnswer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((item) => {
      const a = (item ?? {}) as Record<string, unknown>;
      const questionId = typeof a.questionId === "string" ? a.questionId : "";
      if (!questionId) return null;
      return { questionId, value: a.value == null ? "" : String(a.value) };
    })
    .filter((a): a is ApplyAnswer => a !== null);
  return out.length ? out : undefined;
}

/** submit_fields（dry-run 里被服务截断为 24 字符，仅供展示）。 */
function normalizeSubmitFields(raw: unknown) {
  const f = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    draftId: str(f.draft_id),
    applyId: str(f.apply_id),
    previewId: str(f.preview_id),
    trustScoreHash: str(f.trust_score_hash),
    previewHtmlContentHash: str(f.preview_html_content_hash),
    previewHtmlFileToken: str(f.preview_html_file_token),
    jk: str(f.jk),
  };
}

/** 真投递失败时，把「浏览器/CDP 不可用」类错误补一句可操作的提示。 */
function friendlyApplyError(json: ServiceJson): string {
  const base = extractServiceError(json);
  const stage = typeof json.stage === "string" ? json.stage : "";
  if (/浏览器|CDP|browser/i.test(base) || stage === "browser_tsh") {
    const prefix = base || "未能通过浏览器取得提交所需的校验。";
    return `${prefix}（请确认 AdsPower 浏览器已打开目标 profile 并已登录 Indeed）`;
  }
  if (stage === "prepare") {
    return base ? `备草稿失败：${base}` : "备草稿失败。";
  }
  return base || "投递失败，请稍后重试。";
}

/**
 * POST /api/indeed/apply  body: { jk, confirm }
 * 转发 POST /indeed/apply?jk=&confirm=0|1。
 * confirm=false（默认）：预演——备草稿 + 浏览器取 submit-valid 校验，但不投递。
 * confirm=true：在此基础上真实提交（不可逆）。前端须先预演成功、再显式确认。
 */
export async function POST(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  let body: ApplyRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const jk = (body.jk ?? "").trim();
  if (!jk) {
    return NextResponse.json({ success: false, error: "缺少岗位 jk。" }, { status: 400 });
  }
  const confirm = body.confirm === true;
  const answers = sanitizeAnswers(body.answers);

  const result = await callIndeed("/indeed/apply", {
    method: "POST",
    query: { jk, confirm: confirm ? "1" : "0" },
    // 把用户/知识库确认过的答案带给本地服务;不传则服务侧仍走默认自动答。
    ...(answers ? { body: { answers } } : {}),
    timeoutMs: confirm ? CONFIRM_TIMEOUT_MS : DRY_RUN_TIMEOUT_MS,
  });
  if (result.kind !== "ok") {
    return transportErrorResponse(
      result,
      confirm
        ? "投递超时（已超过 2 分钟）。请用「复核状态」确认是否已投递，避免重复投递。"
        : "预演超时（已超过 90 秒），请重试。",
    );
  }

  const json: ServiceJson = result.json;
  if (!json.ok) {
    return NextResponse.json({ success: false, error: friendlyApplyError(json) }, { status: 502 });
  }

  if (!confirm) {
    return NextResponse.json({
      success: true,
      data: {
        jk: typeof json.jk === "string" ? json.jk : jk,
        dryRun: true,
        note: typeof json.note === "string" ? json.note : "",
        questions: normalizeQuestions(json.questions),
        answers: normalizeAnswers(json.answers),
        submitFields: normalizeSubmitFields(json.submit_fields),
      },
    });
  }

  const submitted = json.submitted === true;
  const submitApplication = (json.submitApplication ?? {}) as Record<string, unknown>;
  const appliedStatus = (json.applied_status ?? null) as Record<string, unknown> | null;
  return NextResponse.json({
    success: true,
    data: {
      jk: typeof json.jk === "string" ? json.jk : jk,
      dryRun: false,
      submitted,
      errors: json.errors ?? null,
      successPageUrl:
        typeof submitApplication.successPageUrl === "string"
          ? submitApplication.successPageUrl
          : "",
      dcmId: typeof submitApplication.dcmId === "string" ? submitApplication.dcmId : "",
      applied: appliedStatus?.applied === true,
      appliedMs: typeof appliedStatus?.appliedMs === "number" ? appliedStatus.appliedMs : null,
    },
  });
}
