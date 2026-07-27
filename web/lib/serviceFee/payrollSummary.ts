/**
 * 从「payroll summary」PDF 的文本里读出 **Employer Taxes 合计**(= 客户那边实际交出去的
 * 雇主税,收费计算器里的「实际 tax」)。
 *
 * 为什么不直接找 "Total" 那一行:PDF 是多列并排的表格,pdf-parse 抽出来的文本会把
 * 「Employee Taxes」与「Employer Taxes」两列的 `Total$xxx` 混在一起,单看文本无法分辨
 * 哪个 Total 属于哪一列。因此改用 Totals 列里两个稳定的值反推:
 *
 *   Employer Taxes 合计 = Employer Cost − Gross
 *   (例:$1,117.33 − $1,000.00 = $117.33,与 PDF 里 Employer Taxes 的 Total 一致)
 *
 * 算完再拿文本里所有 `Total$xxx` 做一次交叉验证(matchedTotalLine),对上了才算高置信度。
 * 纯函数,不碰 fs / DB,便于单测。
 */

export interface ParsedPayrollSummary {
  /** Employer Taxes 合计($);无法可靠识别时为 null */
  employerTaxTotal: number | null;
  /** Gross Wages($) */
  gross: number | null;
  /** Employer Cost($) = Gross + Employer Taxes */
  employerCost: number | null;
  /** 发薪日,原样保留 'MM/DD/YYYY';识别不到为 null */
  payDay: string | null;
  /** 薪资批次类型,如 "Off Cycle Payroll" / "Regular Payroll";识别不到为 null */
  payrollType: string | null;
  /** 算出的合计是否与 PDF 里某个 `Total$xxx` 完全对上(±0.01) */
  matchedTotalLine: boolean;
}

const EMPTY: ParsedPayrollSummary = {
  employerTaxTotal: null,
  gross: null,
  employerCost: null,
  payDay: null,
  payrollType: null,
  matchedTotalLine: false,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "$1,117.33" → 1117.33;非法返回 null */
function money(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
}

/**
 * 取用于解析的文本段:优先「Payroll Totals」之后的那段(整批薪资的合计 = 客户实付),
 * 没有该小节就用全文。上面各雇员分段与 Payroll Totals 数字相同时二者等价。
 */
function totalsSection(text: string): string {
  const idx = text.lastIndexOf("Payroll Totals");
  return idx >= 0 ? text.slice(idx) : text;
}

/** 从 payroll summary 的纯文本里解析 Employer Taxes 合计等字段。 */
export function parsePayrollSummaryText(text: string): ParsedPayrollSummary {
  if (!text || !text.trim()) return EMPTY;

  // 发薪日与批次类型在页头,取全文
  const payDay = /Pay\s*day\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text)?.[1] ?? null;
  const payrollType =
    /([A-Za-z][A-Za-z ]{0,40}?Payroll)\s*Pay\s*day/i.exec(text)?.[1]?.trim() ?? null;

  const section = totalsSection(text);
  // \s* 允许中间换行:PDF 文本里常是 "Employer\nCost\n$1,117.33"
  const gross = money(/Gross\s*\$?\s*([\d,]+\.\d{2})/i.exec(section)?.[1]);
  const employerCost = money(/Employer\s*Cost\s*\$?\s*([\d,]+\.\d{2})/i.exec(section)?.[1]);

  let employerTaxTotal: number | null = null;
  if (gross != null && employerCost != null && employerCost >= gross) {
    const diff = round2(employerCost - gross);
    // 只接受正数;等于 0 说明没读到雇主税(或该批次确实没有),按识别失败处理
    if (diff > 0) employerTaxTotal = diff;
  }

  // 交叉验证:文本里应当存在一个与之相等的 `Total$xxx`(即 Employer Taxes 列的 Total)
  let matchedTotalLine = false;
  if (employerTaxTotal != null) {
    const re = /Total\s*\$?\s*([\d,]+\.\d{2})/gi;
    for (let m = re.exec(section); m; m = re.exec(section)) {
      const v = money(m[1]);
      if (v != null && Math.abs(v - employerTaxTotal) < 0.005) {
        matchedTotalLine = true;
        break;
      }
    }
  }

  return { employerTaxTotal, gross, employerCost, payDay, payrollType, matchedTotalLine };
}

/**
 * 找出「同一发薪日有多份」的发薪日(疑似同一批薪资重复上传)。
 * 只看已识别出金额的份数;**不擅自剔除**(同一天可能真有两批,如常规 + 补发),
 * 由前端提示用户自己核对。
 */
export function duplicatePayDaysOf(
  items: { payDay: string | null; employerTax: number | null }[],
): string[] {
  const count = new Map<string, number>();
  for (const it of items) {
    if (it.employerTax == null || !it.payDay) continue;
    count.set(it.payDay, (count.get(it.payDay) ?? 0) + 1);
  }
  return Array.from(count.entries())
    .filter(([, n]) => n > 1)
    .map(([d]) => d);
}

/** 分类名是否是「payroll summary」(忽略大小写与空格/下划线/连字符)。 */
export function isPayrollSummaryCategory(category: string): boolean {
  return /payrollsummary/.test(category.toLowerCase().replace(/[\s_-]+/g, ""));
}
