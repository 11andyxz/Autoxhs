/**
 * 雇员信息的校验与文件名/分类清洗。纯函数,客户端与服务端共用
 * (不依赖 fs / path,可安全在浏览器侧 import)。
 */

export interface EmployeeInput {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  address: string;
  phone: string;
  /** 备注:任意补充信息(选填) */
  notes?: string;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 单文件大小上限:20MB */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 允许的文件类型(按扩展名,大小写不敏感):PDF / 图片 / Word */
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

export const MAX_NAME_LEN = 255;
export const MAX_ADDRESS_LEN = 512;
export const MAX_PHONE_LEN = 50;
export const MAX_CATEGORY_LEN = 100;
export const MAX_NOTES_LEN = 5000;

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
 * 清洗分类名:去掉路径分隔符与 .. ,只保留字母数字与 空格 _ - . ,折叠空白,截断长度。
 * 返回清洗后的字符串(可能为空,调用方需判空)。
 */
export function sanitizeCategoryName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\\/]/g, " ") // 路径分隔符 -> 空格
    .replace(/\.\.+/g, ".") // 连续点(含 ..)收敛为单点,杜绝路径穿越
    .replace(/[^A-Za-z0-9 _.\-]/g, "") // 仅保留安全字符
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CATEGORY_LEN);
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

/** 校验雇员基本信息,返回中文错误列表(空数组=通过)。客户端与服务端都调用。 */
export function validateEmployee(e: EmployeeInput): string[] {
  const errs: string[] = [];
  const firstName = e.legalFirstName?.trim() ?? "";
  const lastName = e.legalLastName?.trim() ?? "";
  const email = e.email?.trim() ?? "";
  const address = e.address?.trim() ?? "";
  const phone = e.phone?.trim() ?? "";

  if (!firstName) errs.push("请填写 Legal First Name。");
  else if (firstName.length > MAX_NAME_LEN) errs.push("Legal First Name 过长。");

  if (!lastName) errs.push("请填写 Legal Last Name。");
  else if (lastName.length > MAX_NAME_LEN) errs.push("Legal Last Name 过长。");

  if (!email) errs.push("请填写 Email。");
  else if (email.length > MAX_NAME_LEN || !EMAIL_RE.test(email)) errs.push("Email 格式不正确。");

  if (!address) errs.push("请填写 Address。");
  else if (address.length > MAX_ADDRESS_LEN) errs.push("Address 过长。");

  // Phone 选填:留空允许;填了才校验格式
  if (phone && (phone.length > MAX_PHONE_LEN || !/^[\d\s()+.\-]+$/.test(phone) || (phone.match(/\d/g)?.length ?? 0) < 7)) {
    errs.push("Phone 格式不正确(至少 7 位数字)。");
  }

  if ((e.notes?.trim().length ?? 0) > MAX_NOTES_LEN) errs.push("备注过长(请控制在 5000 字以内)。");

  return errs;
}

/** 把 EmployeeInput 各字段 trim 后返回(用于落库前归一) */
export function trimEmployee(e: EmployeeInput): EmployeeInput {
  return {
    legalFirstName: e.legalFirstName.trim(),
    legalLastName: e.legalLastName.trim(),
    email: e.email.trim(),
    address: e.address.trim(),
    phone: e.phone.trim(),
    notes: (e.notes ?? "").trim(),
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 归一化用于「按姓名归并雇员与收费客户」的键:去首尾空格、小写、折叠中间空白。 */
export function nameMergeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 把单串姓名拆成 first/last:最后一个单词作为 Last Name(姓,通常一个词),
 * 其余作为 First Name。例:"YU YAN PING" → { firstName: "YU YAN", lastName: "PING" }。
 * 单个词时作为 First Name。
 */
export function splitFullName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}
