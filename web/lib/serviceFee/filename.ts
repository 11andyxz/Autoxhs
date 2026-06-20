/** 把客户名清洗成文件名安全片段(保留字母/数字/中日韩文字,其余转下划线) */
export function safeClientSlug(clientName: string): string {
  const slug = clientName
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "Client";
}

/** John_Smith_Payroll_2026-02-17_to_2026-03-17.xlsx */
export function exportFileName(clientName: string, startISO: string, endISO: string): string {
  return `${safeClientSlug(clientName)}_Payroll_${startISO}_to_${endISO}.xlsx`;
}
