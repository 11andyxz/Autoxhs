import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import {
  isBatchAllowedFileName,
  markDuplicates,
  MAX_BATCH_FILES,
  MAX_BATCH_ROWS,
  type BatchRow,
  type ParsedBatchRow,
} from "@/lib/expense/batch";
import { MAX_TOTAL_BYTES, PayloadTooLargeError, readCappedFormData } from "@/lib/expense/form";
import { BatchParseError, parseExpenseBatchFile } from "@/lib/expense/parseBatch";
import { ensureExpenseSchema, findExistingExpenseKeys } from "@/lib/expense/repo";
import { isValidDateStr, MAX_FILE_BYTES, parseBusinessId } from "@/lib/expense/validate";
import { tooMany } from "@/lib/job-hunter/interview/http";
import { MissingApiKeyError } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 同时识别几份材料。放太多会同时开多路长请求(每路可能几十秒),3 路是延迟与并发的折中。 */
const CONCURRENCY = 3;

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** 每份材料各自的识别结果(某一份失败不影响其余) */
interface FileReport {
  name: string;
  count: number;
  error?: string;
}

/** 把单份材料的失败原因翻成中文提示(同时在服务端留日志,不外泄细节)。 */
function describeFileError(err: unknown, name: string): string {
  if (err instanceof BatchParseError) return err.message;
  if (err instanceof MissingApiKeyError) {
    console.error("[expense/parse-batch] OPENAI_API_KEY 未配置");
    return `「${name}」识别失败,请稍后重试。`;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = (err as { code?: string }).code;
    console.error("[expense/parse-batch] OpenAI 错误", { name, status, code });
    if (status === 429 && code !== "insufficient_quota") return `「${name}」当前请求较多,请稍后再试。`;
    return `「${name}」识别失败,请稍后重试。`;
  }
  console.error("[expense/parse-batch] 失败", { name, error: (err as Error)?.name });
  return `「${name}」识别失败,请稍后重试。`;
}

/** 固定并发地跑一批任务,保持结果与输入同序。 */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 接收 1~N 份含多笔交易的材料(对账单 PDF / 账单截图 / CSV),识别出多笔收支返回给前端复核。
 * 只识别,不落盘、不写库——保存走 /api/business-expense/save-batch。
 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return bad("当前请求较多,请稍后再试。", 429);

  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return bad("上传内容过大,请减少文件数量或体积。", 413);
  }
  let form: FormData;
  try {
    form = await readCappedFormData(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return bad("上传内容过大,请减少文件数量或体积。", 413);
    return bad("请求格式有误。");
  }

  const raw = form.getAll("files");
  const files: File[] = [];
  for (const f of raw) {
    if (!(f instanceof File)) return bad("上传格式有误,请重试。");
    files.push(f);
  }
  if (!files.length) return bad("请先选择要识别的文件。");
  if (files.length > MAX_BATCH_FILES) return bad(`一次最多识别 ${MAX_BATCH_FILES} 个文件。`);
  for (const f of files) {
    if (f.size === 0) return bad(`「${f.name}」是空文件,请重新选择。`);
    if (f.size > MAX_FILE_BYTES) return bad(`「${f.name}」超过 20MB 上限。`);
    if (!isBatchAllowedFileName(f.name)) {
      return bad(`「${f.name}」类型不支持(仅 PDF / 图片 / CSV / TXT)。`);
    }
  }

  // 年份推断要用「用户那边的今天」:服务器可能在别的时区,跨日会把 12/31 推成明年。
  const clientToday = String(form.get("today") ?? "");
  const today = isValidDateStr(clientToday) ? clientToday : new Date().toISOString().slice(0, 10);

  const reports: FileReport[] = [];
  const collected: Array<BatchRow & { sourceName: string }> = [];
  try {
    const results = await mapWithLimit(files, CONCURRENCY, async (file) => {
      const bytes = Buffer.from(await file.arrayBuffer());
      try {
        const rows = await parseExpenseBatchFile({ name: file.name, mimeType: file.type, bytes }, today);
        return { name: file.name, rows };
      } catch (err) {
        return { name: file.name, rows: [] as BatchRow[], error: describeFileError(err, file.name) };
      }
    });
    for (const r of results) {
      reports.push({ name: r.name, count: r.rows.length, error: r.error });
      for (const row of r.rows) collected.push({ ...row, sourceName: r.name });
    }
  } catch (err) {
    console.error("[expense/parse-batch] 批量识别异常", { name: (err as Error)?.name });
    return bad("识别失败,请稍后重试。", 500);
  }

  const truncated = collected.length > MAX_BATCH_ROWS;
  const kept = truncated ? collected.slice(0, MAX_BATCH_ROWS) : collected;

  // 指定了 business 才查重(重复只在同一本账里才有意义);查重失败不影响识别结果。
  let existingKeys: string[] = [];
  const businessId = parseBusinessId(String(form.get("businessId") ?? ""));
  if (businessId !== null && kept.length) {
    try {
      await ensureExpenseSchema();
      existingKeys = await findExistingExpenseKeys(
        businessId,
        kept.map((r) => r.spentOn),
      );
    } catch (err) {
      console.error("[expense/parse-batch] 查重失败(忽略)", { code: (err as { code?: string })?.code });
    }
  }
  const rows: ParsedBatchRow[] = markDuplicates(kept, existingKeys);

  return NextResponse.json({ success: true, rows, files: reports, truncated });
}
