/**
 * 批量导入(一次上传 → 识别出多笔收支)的纯逻辑:
 * 支持的文件类型判定、模型输出归一、重复判定键。
 *
 * 不依赖 fs / openai / mysql,客户端与服务端共用,可直接单测
 * (与 validate.ts 同一约定:纯函数放这里,IO 放 parseBatch.ts / 路由层)。
 */
import {
  isValidDateStr,
  fileExtension,
  parseAmount,
  MAX_CATEGORY_LEN,
  MAX_NOTE_LEN,
  MAX_PAYMENT_LEN,
  MAX_VENDOR_LEN,
  type ExpenseType,
} from "./validate";

/** 一次批量导入最多落库的笔数(防一份几百页对账单把界面/事务撑爆) */
export const MAX_BATCH_ROWS = 200;
/** 一次最多上传几个待识别文件 */
export const MAX_BATCH_FILES = 10;

/**
 * 批量识别允许的文件类型。比凭证(ALLOWED_FILE_EXTENSIONS)多了 csv/txt——
 * 银行导出的流水常是 CSV;少了 doc/docx——对账单几乎不会是 Word,而 Word 需要额外解析链路。
 */
export const BATCH_ALLOWED_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "csv",
  "txt",
] as const;

export type BatchFileKind = "pdf" | "image" | "text";

/** 按扩展名判断走哪条识别链路;不支持返回 null。 */
export function batchFileKind(name: string): BatchFileKind | null {
  const ext = fileExtension(name);
  if (ext === "pdf") return "pdf";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp" || ext === "gif") return "image";
  if (ext === "csv" || ext === "txt") return "text";
  return null;
}

export function isBatchAllowedFileName(name: string): boolean {
  return batchFileKind(name) !== null;
}

/** 识别出的一笔(字段与「记一笔」表单一致,除 businessId 由用户统一指定) */
export interface BatchRow {
  type: ExpenseType;
  /** YYYY-MM-DD;识别不出时为 ""(前端会要求补全后才能保存) */
  spentOn: string;
  /** 正数字符串(已去掉负号/货币符号/千分位) */
  amount: string;
  category: string;
  vendor: string;
  paymentMethod: string;
  note: string;
}

/** 接口返回给前端的一行:附带来源文件名与「可能重复」标记 */
export interface ParsedBatchRow extends BatchRow {
  sourceName: string;
  duplicate: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 金额文本 → 正数字符串;非法返回 null。同时告知原文是否为负(负=支出)。 */
function readAmount(raw: string): { amount: string; negative: boolean } | null {
  const trimmed = raw.trim();
  // 括号记账法 (12.34) 也表示负数
  const paren = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()\s$¥￥,]/g, "");
  const negative = paren || /^[-−–—]/.test(cleaned);
  const abs = cleaned.replace(/^[-−–—+]/, "");
  if (parseAmount(abs) === null) return null;
  return { amount: abs, negative };
}

/**
 * 把模型输出(`{rows:[...]}` 或直接一个数组)归一成可用的行。
 * - 金额读不出的行直接丢弃(没有金额无从记账)
 * - 金额带负号/括号 → 一律判为支出(出账),不管模型自己填的 type
 * - 日期非法留 "",交给用户在复核表里补
 */
export function normalizeBatchRows(raw: unknown, max: number = MAX_BATCH_ROWS): BatchRow[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rows?: unknown } | null)?.rows)
      ? ((raw as { rows: unknown[] }).rows)
      : [];

  const out: BatchRow[] = [];
  for (const item of arr) {
    if (out.length >= max) break;
    const o = (item ?? {}) as Record<string, unknown>;
    const amt = readAmount(str(o.amount));
    if (!amt) continue;

    const declared = o.type === "income" ? "income" : o.type === "expense" ? "expense" : "";
    // 负号是账单里最硬的信号,优先于模型的判断
    const type: ExpenseType = amt.negative ? "expense" : declared || "expense";

    const spentOnRaw = str(o.spentOn);
    out.push({
      type,
      spentOn: isValidDateStr(spentOnRaw) ? spentOnRaw : "",
      amount: amt.amount,
      category: str(o.category).slice(0, MAX_CATEGORY_LEN),
      vendor: str(o.vendor).slice(0, MAX_VENDOR_LEN),
      paymentMethod: str(o.paymentMethod).slice(0, MAX_PAYMENT_LEN),
      note: str(o.note).slice(0, MAX_NOTE_LEN),
    });
  }
  return out;
}

/**
 * 重复判定键:同一 business 下「同日期 + 同金额」视为可能重复
 * (重复导入同一份对账单是最常见也最伤的误操作)。
 * 日期或金额缺失时返回 ""——无从判定,不参与去重。
 */
export function dupKey(row: { spentOn: string; amount: string | number }): string {
  const date = typeof row.spentOn === "string" ? row.spentOn.trim() : "";
  if (!isValidDateStr(date)) return "";
  const n = typeof row.amount === "number" ? row.amount : parseAmount(String(row.amount ?? ""));
  if (n === null || !Number.isFinite(n)) return "";
  return `${date}|${n.toFixed(2)}`;
}

/**
 * 标注可能重复的行:既比对库里已有的键,也比对本批次内先出现的行
 * (同一份文件被选了两次时,第二次出现的那些也会被标出来)。
 */
export function markDuplicates<T extends BatchRow>(
  rows: T[],
  existingKeys: Iterable<string>,
): Array<T & { duplicate: boolean }> {
  const seen = new Set<string>(existingKeys);
  return rows.map((r) => {
    const key = dupKey(r);
    const duplicate = key !== "" && seen.has(key);
    if (key) seen.add(key);
    return { ...r, duplicate };
  });
}

/** 汇总选中行的收入/支出/净额(前端表头与保存前确认都用它)。 */
export function sumBatchRows(rows: BatchRow[]): { income: number; expense: number; net: number } {
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    const n = parseAmount(r.amount);
    if (n === null) continue;
    if (r.type === "income") income += n;
    else expense += n;
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return { income: round(income), expense: round(expense), net: round(income - expense) };
}
