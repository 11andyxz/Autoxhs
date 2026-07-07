import { NextResponse, type NextRequest } from "next/server";

import { extractTextFromFile, FileParseError } from "@/lib/job-hunter/parse";
import { rateLimit } from "@/lib/rateLimit";
import { detectNextWeekFromText } from "@/lib/workEmail/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_TEXT_LENGTH = 40_000;

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * 从上传的上一封邮件(PDF/DOCX/文本)里识别目标周 = 邮件覆盖周的「下一周」。
 * 供前端在选好文件后自动预填「目标周」。识别不到返回 targetWeek=null(前端保留默认值)。
 */
export async function POST(req: NextRequest) {
  if (!rateLimit(clientKey(req)).allowed) {
    return NextResponse.json({ success: false, error: "请求过多。" }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  let text = "";
  try {
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json({ success: false, error: "文件过大。" }, { status: 400 });
      }
      text = await extractTextFromFile(file);
    } else {
      const raw = form.get("priorText");
      text = typeof raw === "string" ? raw : "";
    }
  } catch (err) {
    // 解析失败不算致命:识别不到就让前端保留默认目标周
    if (err instanceof FileParseError) {
      return NextResponse.json({ success: true, targetWeek: null });
    }
    return NextResponse.json({ success: true, targetWeek: null });
  }

  if (text.length > MAX_TEXT_LENGTH) text = text.slice(0, MAX_TEXT_LENGTH);
  const targetWeek = detectNextWeekFromText(text, new Date().getFullYear());
  return NextResponse.json({ success: true, targetWeek });
}
