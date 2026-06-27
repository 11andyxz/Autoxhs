/**
 * 解析 I-983(STEM OPT 培训计划)可填写 PDF 表单,抽取雇员(学生)信息。
 * 仅服务器端(runtime="nodejs")。用 pdf-lib 按字段名读取 AcroForm 字段值,
 * 不做 LLM 调用、不写盘。
 */
import { PDFDocument, PDFDict, PDFHexString, PDFName, PDFString } from "pdf-lib";

export interface I983Employee {
  firstName: string;
  lastName: string;
  email: string;
  address: string;
  phone: string; // I-983 不含雇员本人电话,恒为 ""
}

export interface I983ParseResult {
  /** 是否识别为 I-983(至少抽到学生姓名或邮箱) */
  recognized: boolean;
  data: I983Employee;
}

/** 抛出后由路由层映射为用户提示 */
export class I983ParseError extends Error {}

function decodeStr(obj: unknown): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText().trim();
  return "";
}

/**
 * 读取所有表单字段为 name -> value 映射。
 * 不走 getForm()/getFields():部分由 WPS 等工具保存的 I-983 把字段做成页面控件,
 * 没有正确登记到 AcroForm /Fields,标准表单 API 读不到。改为遍历全部间接对象
 * (pdf-lib 加载时已解压对象流),凡是带 /T(字段名)且带 /V(值)的字典都收集。
 */
function readFieldValues(doc: PDFDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const name = decodeStr(obj.lookup(PDFName.of("T")));
    if (!name) continue;
    const value = decodeStr(obj.lookup(PDFName.of("V")));
    const existing = map.get(name);
    // 首次出现即记录;若已记录的是空值而本次有值,则用有值的覆盖
    if (existing === undefined || (existing === "" && value)) map.set(name, value);
  }
  return map;
}

/** 找到第一个「名字匹配 predicate 且值非空」的字段值。 */
function findValue(fields: Map<string, string>, predicate: (name: string) => boolean): string {
  for (const [name, value] of fields) {
    if (value && predicate(name)) return value;
  }
  return "";
}

/**
 * 拆分学生姓名。I-983 标准格式为「Surname/Primary Name, Given Name」(姓在前、逗号、名在后)。
 * 返回 { firstName, lastName }。
 */
export function splitStudentName(raw: string): { firstName: string; lastName: string } {
  const value = raw.trim();
  if (!value) return { firstName: "", lastName: "" };
  const comma = value.indexOf(",");
  if (comma >= 0) {
    const lastName = value.slice(0, comma).trim();
    const firstName = value.slice(comma + 1).trim();
    return { firstName, lastName };
  }
  // 无逗号:回退按空格拆,首词为名、其余为姓;只有一个词则全部当姓
  const parts = value.split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export async function parseI983(bytes: Buffer | Uint8Array): Promise<I983ParseResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new I983ParseError("未能读取该 PDF(可能已损坏或加密)。");
  }

  const fields = readFieldValues(doc);

  const lname = (n: string) => n.toLowerCase();
  // 学生姓名:Section 1 的「Student Name (Surname/Primary Name, Given Name)」,排除带 (2) 的重复字段
  const nameRaw = findValue(
    fields,
    (n) => lname(n).startsWith("student name (surname") && !n.includes("(2)"),
  ) || findValue(fields, (n) => lname(n).startsWith("student name"));
  const email = findValue(fields, (n) => lname(n).includes("student email"));
  // 远程办公场景下,Employer Site Address 即学生地址
  const address = findValue(fields, (n) => lname(n).includes("site address"));

  const { firstName, lastName } = splitStudentName(nameRaw);

  return {
    recognized: !!(nameRaw || email),
    data: { firstName, lastName, email, address, phone: "" },
  };
}
