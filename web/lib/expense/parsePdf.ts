/**
 * 从财务单据 PDF(如 Stripe payout / 收据 / 发票 / 扣款记录)抽取「一笔」收支信息,
 * 供记账本表单自动填充。仅服务器端(runtime="nodejs")。
 * 流程:pdf-parse 提取纯文本 → OpenAI 结构化抽取(json_schema)。
 */
// 直接引内部入口,绕开 pdf-parse 包顶层的 debug 自测(非 CommonJS 环境会去读测试 PDF 报错)。
// @ts-expect-error pdf-parse 内部入口没有类型声明
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import { getClient, getModel } from "@/lib/openai";
import { isValidDateStr, parseAmount } from "./validate";

/** PDF 无法读取/解析时抛出,路由层映射为用户提示 */
export class PdfParseError extends Error {}

export interface ParsedExpense {
  type: "income" | "expense" | "";
  spentOn: string; // YYYY-MM-DD 或 ""
  amount: string; // 正数字符串 或 ""
  category: string;
  vendor: string;
  paymentMethod: string;
  note: string;
}
export interface ParseResult {
  recognized: boolean;
  data: ParsedExpense;
}

const MAX_TEXT = 15_000;

function emptyData(): ParsedExpense {
  return { type: "", spentOn: "", amount: "", category: "", vendor: "", paymentMethod: "", note: "" };
}

const SYSTEM = `你是记账助手。用户给你一份财务单据(如 Stripe payout / 收据 / 发票 / 扣款记录)的纯文本,请从中抽取【一笔】收支记录,只输出符合 schema 的 JSON。
规则:
- recognized:文本确为财务单据且含明确金额时为 true;否则 false(其余字段一律空字符串)。
- type:收到钱=income(如 payout 到账、客户付款、销售、退款到账);付出钱=expense(如扣款、订阅费、手续费、采购)。无法判断留 ""。
- spentOn:该笔日期(完成/到账/交易日),格式严格 YYYY-MM-DD;无法确定留 ""。
- amount:主金额(如 payout 净额、订单总额),正数,最多两位小数,只含数字与小数点(不要 $、不要千分位逗号)。
- category:简短中文类别(收入如 服务收入/产品销售;支出如 软件订阅/银行手续费/广告推广);拿不准留 ""。
- vendor:对方(收入填来源/付款方,如 Stripe 或客户名;支出填商家)。
- paymentMethod:如 银行转账 / 信用卡 / Stripe;拿不准留 ""。
- note:简要补充(如 payout id、statement descriptor、手续费、卡号后四位),不超过 200 字。
不要编造不存在的信息;任何不确定的字段都留空字符串。金额单位视为 USD。`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recognized: { type: "boolean" },
    type: { type: "string", enum: ["income", "expense", ""] },
    spentOn: { type: "string" },
    amount: { type: "string" },
    category: { type: "string" },
    vendor: { type: "string" },
    paymentMethod: { type: "string" },
    note: { type: "string" },
  },
  required: ["recognized", "type", "spentOn", "amount", "category", "vendor", "paymentMethod", "note"],
} as const;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalize(raw: unknown): ParseResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const type = o.type === "income" || o.type === "expense" ? o.type : "";
  // 金额/日期用表单同一套校验器,保证「识别成功即可保存」(避免填了却过不了 validateExpense)
  const amountRaw = str(o.amount).replace(/[$,\s]/g, "");
  const amount = parseAmount(amountRaw) !== null ? amountRaw : "";
  const spentOnRaw = str(o.spentOn);
  const spentOn = isValidDateStr(spentOnRaw) ? spentOnRaw : "";
  const data: ParsedExpense = {
    type,
    spentOn,
    amount,
    category: str(o.category).slice(0, 100),
    vendor: str(o.vendor).slice(0, 255),
    paymentMethod: str(o.paymentMethod).slice(0, 50),
    note: str(o.note).slice(0, 2000),
  };
  // 至少抽到金额才算「识别成功」——否则无从记账
  const recognized = o.recognized === true && !!amount;
  return { recognized, data };
}

/** 解析财务单据 PDF,返回抽取到的一笔收支(recognized=false 表示未能识别)。 */
export async function parseExpensePdf(bytes: Buffer): Promise<ParseResult> {
  let text = "";
  try {
    const r = await pdfParse(bytes);
    text = (r?.text ?? "").trim();
  } catch {
    throw new PdfParseError("PDF 解析失败,请确认文件未加密且内容可复制。");
  }
  if (!text) return { recognized: false, data: emptyData() };

  const client = getClient(60_000, 0);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text.slice(0, MAX_TEXT) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "expense_extract",
        strict: true,
        schema: SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const out = response.output_text;
  if (!out) return { recognized: false, data: emptyData() };
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    return { recognized: false, data: emptyData() };
  }
  return normalize(json);
}
