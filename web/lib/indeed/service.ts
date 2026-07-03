import { NextResponse, type NextRequest } from "next/server";

import { rateLimit } from "@/lib/rateLimit";

/**
 * 本地 Indeed 自动化服务（Js-Reverse/sites/indeed，默认 127.0.0.1:3457，前缀 /indeed/*）。
 * 仅服务器端读取，严禁加 NEXT_PUBLIC_ 前缀（否则会暴露到浏览器）。
 * 本目录下的路由只做「同源代理」：解析/校验入参 → 转发到本地服务 → 把 {ok,…,error}
 * 归一化成应用统一的 {success,data}/{success:false,error}。所有签名/逆向都在该本地服务里完成。
 */
export const INDEED_BASE = process.env.INDEED_API_BASE || "http://127.0.0.1:3457";

const RATE_LIMIT_ERROR = "当前请求较多，请稍后再试。";

/** 取调用方 IP 作为限流 key（与 job-hunter/generate 一致）。 */
export function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/** 命中限流时返回 429 响应；未命中返回 null（继续处理）。 */
export function rateLimitedResponse(req: NextRequest): NextResponse | null {
  if (rateLimit(clientKey(req)).allowed) return null;
  return NextResponse.json({ success: false, error: RATE_LIMIT_ERROR }, { status: 429 });
}

export type ServiceJson = Record<string, unknown>;

export type IndeedCallResult =
  | { kind: "ok"; status: number; json: ServiceJson }
  | { kind: "timeout" }
  | { kind: "connection" }
  | { kind: "badjson"; status: number };

/**
 * 调用本地 Indeed 服务。统一处理 URL 拼接、AbortController 超时、JSON 解析与连接/超时错误。
 * 不对业务字段（ok/error/…）做判断——交给各路由按自己的语义归一化。
 */
export async function callIndeed(
  path: string,
  opts: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs: number;
  },
): Promise<IndeedCallResult> {
  const url = new URL(path, INDEED_BASE);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const hasBody = opts.body !== undefined;
    const res = await fetch(url, {
      method: opts.method ?? (hasBody ? "POST" : "GET"),
      signal: controller.signal,
      ...(hasBody
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }
        : {}),
    });
    const text = await res.text();
    try {
      return { kind: "ok", status: res.status, json: JSON.parse(text) as ServiceJson };
    } catch {
      return { kind: "badjson", status: res.status };
    }
  } catch (err) {
    return (err as Error)?.name === "AbortError" ? { kind: "timeout" } : { kind: "connection" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把「连不上 / 超时 / 非 JSON」这类传输层失败转成统一的 502 响应。
 * 连接失败提示里带上 BASE，方便用户确认本地服务是否在运行。
 */
export function transportErrorResponse(
  result: Exclude<IndeedCallResult, { kind: "ok" }>,
  timeoutMsg = "请求超时，请重试。",
): NextResponse {
  // body 里带上 code(=kind)：让客户端区分「超时(可能已生效,不可盲目重试)」与「连不上(肯定没生效,可直接重试)」。
  if (result.kind === "timeout") {
    return NextResponse.json({ success: false, error: timeoutMsg, code: "timeout" }, { status: 502 });
  }
  if (result.kind === "badjson") {
    return NextResponse.json(
      {
        success: false,
        error: `本地 Indeed 服务返回非 JSON 响应（HTTP ${result.status}）。`,
        code: "badjson",
      },
      { status: 502 },
    );
  }
  return NextResponse.json(
    {
      success: false,
      error: `无法连接本地 Indeed 服务(${INDEED_BASE})，请确认它在运行（必要时已打开并登录 AdsPower 浏览器）。`,
      code: "connection",
    },
    { status: 502 },
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type IndeedQuestion = {
  id: string;
  type: string;
  required: boolean;
  label: string;
  options: Array<{ value: string; label: string }> | null;
  autoAnswer: string | null;
};

/** 归一化本地服务的雇主问题列表（questions / apply 共用）。 */
export function normalizeQuestions(raw: unknown): IndeedQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const q = (item ?? {}) as Record<string, unknown>;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).map((opt) => ({
          value: typeof opt.value === "string" ? opt.value : String(opt.value ?? ""),
          label: typeof opt.label === "string" ? opt.label : String(opt.label ?? ""),
        }))
      : null;
    return {
      id: typeof q.id === "string" ? q.id : "",
      type: typeof q.type === "string" ? q.type : "",
      required: q.required === true,
      label: typeof q.label === "string" ? q.label : "",
      options,
      autoAnswer:
        typeof q.auto_answer === "string"
          ? q.auto_answer
          : q.auto_answer == null
            ? null
            : String(q.auto_answer),
    };
  });
}

/** 归一化 {questionId,value} 自动答案列表。 */
export function normalizeAnswers(raw: unknown): Array<{ questionId: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const a = (item ?? {}) as Record<string, unknown>;
    return {
      questionId: typeof a.questionId === "string" ? a.questionId : "",
      value: a.value == null ? "" : String(a.value),
    };
  });
}

/** 从本地服务的 {ok:false} 响应里抽出可读错误（兼容 error/detail/msg/message）。 */
export function extractServiceError(json: ServiceJson): string {
  for (const key of ["error", "detail", "msg", "message"]) {
    const text = asText(json[key]);
    if (text) return text;
  }
  return "";
}
