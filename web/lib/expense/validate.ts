/**
 * Business 花费(记账本)的校验与文件名清洗。纯函数,客户端与服务端共用
 * (不依赖 fs / path,可安全在浏览器侧 import)。
 *
 * 每个功能的 validate 都自包含(见 employee/validate.ts、serviceFee),
 * 这里也复制通用的文件名工具,保持 expense 功能与其他功能解耦。
 */

export interface ExpenseInput {
  /** 花费日期(YYYY-MM-DD) */
  spentOn: string;
  /** 金额(USD),表单里是字符串,落库前用 parseAmount 归一为数字 */
  amount: string;
  /** 类别,如「办公用品」「差旅交通」 */
  category: string;
  /** 收款方 / 商家(选填) */
  vendor: string;
  /** 付款方式,如「信用卡」「现金」(选填) */
  paymentMethod: string;
  /** 备注(选填) */
  note: string;
}

/** 类别候选(datalist 提示,不强制) */
export const CATEGORY_PRESETS = [
  "办公用品",
  "差旅交通",
  "软件订阅",
  "广告推广",
  "餐饮招待",
  "银行手续费",
  "薪资相关",
  "设备采购",
  "水电房租",
  "专业服务",
  "税费",
  "其他",
] as const;

/** 付款方式候选(datalist 提示,不强制) */
export const PAYMENT_METHOD_PRESETS = [
  "信用卡",
  "借记卡",
  "现金",
  "银行转账",
  "支票",
  "PayPal",
  "其他",
] as const;

/** 单文件大小上限:20MB */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 允许的凭证类型(按扩展名,大小写不敏感):PDF / 图片 / Word */
export const ALLOWED_FILE_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "doc",
  "docx",
] as const;

export const MAX_CATEGORY_LEN = 100;
export const MAX_VENDOR_LEN = 255;
export const MAX_PAYMENT_LEN = 50;
export const MAX_NOTE_LEN = 2000;
/** 金额上限:99,999,999.99(DECIMAL(12,2) 内的合理业务上限) */
export const MAX_AMOUNT = 99_999_999.99;

/** 取文件扩展名(小写,不含点)。无扩展名返回 "" */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedFileName(name: string): boolean {
  return (ALLOWED_FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/**
 * 清洗文件名(保留扩展名)。用于落盘时的 stored name。
 * 返回安全的 "base.ext";若清洗后为空,回退为 "file"(+ 原扩展名,若合法)。
 */
export function sanitizeStoredFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).normalize("NFKC");
  const ext = fileExtension(base);
  const dot = base.lastIndexOf(".");
  const stem = ext && dot > 0 ? base.slice(0, dot) : base;
  const safeStem = stem
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9 _.\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const cleanStem = safeStem || "file";
  return ext ? `${cleanStem}.${ext}` : cleanStem;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 YYYY-MM-DD 是否为 2000..2100 内的真实日历日期。 */
export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 把金额字符串解析成数字(两位小数)。允许千分位逗号。
 * 非法 / <=0 / 超上限返回 null。
 */
export function parseAmount(raw: string): number | null {
  const t = (raw ?? "").trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

/** 校验花费记录,返回中文错误列表(空数组=通过)。客户端与服务端都调用。 */
export function validateExpense(e: ExpenseInput): string[] {
  const errs: string[] = [];

  if (!e.spentOn?.trim()) errs.push("请选择花费日期。");
  else if (!isValidDateStr(e.spentOn.trim())) errs.push("花费日期格式不正确(应为 YYYY-MM-DD)。");

  if (!e.amount?.trim()) errs.push("请填写金额。");
  else if (parseAmount(e.amount) === null) errs.push("金额不正确(需为大于 0 且不超过 99,999,999.99 的数字,最多两位小数)。");

  const category = e.category?.trim() ?? "";
  if (!category) errs.push("请填写类别(如 办公用品)。");
  else if (category.length > MAX_CATEGORY_LEN) errs.push("类别过长。");

  if ((e.vendor?.trim().length ?? 0) > MAX_VENDOR_LEN) errs.push("收款方过长。");
  if ((e.paymentMethod?.trim().length ?? 0) > MAX_PAYMENT_LEN) errs.push("付款方式过长。");
  if ((e.note?.trim().length ?? 0) > MAX_NOTE_LEN) errs.push("备注过长(请控制在 2000 字以内)。");

  return errs;
}

/** trim 各字段(用于落库前归一)。 */
export function trimExpense(e: ExpenseInput): ExpenseInput {
  return {
    spentOn: e.spentOn.trim(),
    amount: e.amount.trim(),
    category: e.category.trim(),
    vendor: (e.vendor ?? "").trim(),
    paymentMethod: (e.paymentMethod ?? "").trim(),
    note: (e.note ?? "").trim(),
  };
}
