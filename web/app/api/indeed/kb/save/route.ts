import { NextResponse, type NextRequest } from "next/server";

import { saveAnswers, type KbSaveItem } from "@/lib/indeed/kb";
import { rateLimitedResponse } from "@/lib/indeed/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/indeed/kb/save  body: { items: [{label, type, options, value, valueLabel}] }
 * 把用户确认过的「雇主问题 → 答案」写入个人知识库(仅存有值的),供下次自动/预填。
 */
export async function POST(req: NextRequest) {
  const limited = rateLimitedResponse(req);
  if (limited) return limited;

  let body: { items?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  if (!Array.isArray(body.items)) {
    return NextResponse.json({ success: false, error: "缺少 items。" }, { status: 400 });
  }

  const items: KbSaveItem[] = body.items.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const options = Array.isArray(it.options)
      ? (it.options as Array<Record<string, unknown>>).map((o) => ({
          value: typeof o.value === "string" ? o.value : String(o.value ?? ""),
          label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
        }))
      : null;
    return {
      label: typeof it.label === "string" ? it.label : "",
      type: typeof it.type === "string" ? it.type : "",
      options,
      value: it.value == null ? "" : String(it.value),
      valueLabel: typeof it.valueLabel === "string" ? it.valueLabel : null,
    };
  });

  try {
    const saved = await saveAnswers(items);
    return NextResponse.json({ success: true, data: { saved } });
  } catch {
    return NextResponse.json(
      { success: false, error: "保存到知识库失败(数据库不可用?)。" },
      { status: 502 },
    );
  }
}
