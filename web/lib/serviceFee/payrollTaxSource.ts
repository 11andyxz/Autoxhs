/**
 * 「实际 tax」的自动来源:把某客户名下(按姓名归并到的雇员)已上传的 payroll summary PDF
 * 逐份读出 Employer Taxes 合计并汇总 —— 上传了就说明这笔薪资真的发生了,雇主税就是客户
 * 那边实际付出去的钱。仅服务器端(fs + pdf-parse + DB)。
 *
 * 解析规则见 ./payrollSummary.ts;这里只负责「找文件 → 读文本 → 汇总 + 标注异常」。
 */
import { promises as fs } from "node:fs";

// 直接引内部入口,绕开 pdf-parse 包顶层的 debug 自测(与 lib/job-hunter/parse.ts 同样处理)
// @ts-expect-error pdf-parse 内部入口没有类型声明
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import {
  ensureEmployeeSchema,
  listEmployees,
  listStoredFilesForEmployees,
} from "@/lib/employee/repo";
import { nameMergeKey } from "@/lib/employee/validate";
import { resolveStoredFile } from "@/lib/employee/storage";
import {
  duplicatePayDaysOf,
  isPayrollSummaryCategory,
  parsePayrollSummaryText,
} from "./payrollSummary";

export interface PayrollTaxFile {
  fileId: number;
  fileName: string;
  category: string;
  /** 发薪日 'MM/DD/YYYY';识别不到为 null */
  payDay: string | null;
  payrollType: string | null;
  /** 该份 payroll summary 的 Employer Taxes 合计;null = 未能识别 */
  employerTax: number | null;
  /** 是否与 PDF 里的 Total 行交叉验证一致 */
  verified: boolean;
  /** 未能识别时的中文原因 */
  note?: string;
}

export interface PayrollTaxSummary {
  /** 归并到的雇员名(没匹配到雇员时为 null) */
  employeeName: string | null;
  /** 识别成功的各份之和($) */
  total: number;
  /** 识别成功的份数 */
  parsedCount: number;
  files: PayrollTaxFile[];
  /** 有多份 payroll summary 落在同一发薪日(可能重复上传),这里给出这些发薪日 */
  duplicatePayDays: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isPdf(name: string, mime: string): boolean {
  return mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

/** 读一份 payroll summary PDF 的文本(失败抛错,由调用方转成 note)。 */
async function pdfText(relativePath: string): Promise<string> {
  const abs = resolveStoredFile(relativePath);
  const buf = await fs.readFile(abs);
  const res = await pdfParse(buf);
  return String(res?.text ?? "");
}

/**
 * 汇总某客户的 payroll summary 雇主税。clientName 用「归一化全名」匹配雇员
 * (与 /api/employee/people 的人员归并同一套规则)。
 */
export async function getPayrollTaxForClient(clientName: string): Promise<PayrollTaxSummary> {
  await ensureEmployeeSchema();
  const key = nameMergeKey(clientName);
  const employees = (await listEmployees()).filter(
    (e) => nameMergeKey(`${e.legalFirstName} ${e.legalLastName}`) === key,
  );
  if (!employees.length) {
    return { employeeName: null, total: 0, parsedCount: 0, files: [], duplicatePayDays: [] };
  }

  const all = await listStoredFilesForEmployees(employees.map((e) => e.id));
  const targets = all.filter((f) => isPayrollSummaryCategory(f.category));

  const files: PayrollTaxFile[] = [];
  for (const f of targets) {
    const base: PayrollTaxFile = {
      fileId: f.id,
      fileName: f.originalName,
      category: f.category,
      payDay: null,
      payrollType: null,
      employerTax: null,
      verified: false,
    };
    if (!isPdf(f.originalName, f.mimeType)) {
      files.push({ ...base, note: "只支持 PDF,已跳过" });
      continue;
    }
    let text: string;
    try {
      text = await pdfText(f.relativePath);
    } catch {
      files.push({ ...base, note: "读取失败(文件丢失或已加密)" });
      continue;
    }
    const parsed = parsePayrollSummaryText(text);
    if (parsed.employerTaxTotal == null) {
      files.push({
        ...base,
        payDay: parsed.payDay,
        payrollType: parsed.payrollType,
        note: "未能识别 Employer Taxes 合计,请手动填写",
      });
      continue;
    }
    files.push({
      ...base,
      payDay: parsed.payDay,
      payrollType: parsed.payrollType,
      employerTax: parsed.employerTaxTotal,
      verified: parsed.matchedTotalLine,
    });
  }

  const parsedFiles = files.filter((f) => f.employerTax != null);
  return {
    employeeName: `${employees[0].legalFirstName} ${employees[0].legalLastName}`.trim(),
    total: round2(parsedFiles.reduce((s, f) => s + (f.employerTax ?? 0), 0)),
    parsedCount: parsedFiles.length,
    files,
    duplicatePayDays: duplicatePayDaysOf(files),
  };
}
