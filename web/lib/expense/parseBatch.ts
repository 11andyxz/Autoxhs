/**
 * 从一份「多笔交易」的材料里抽出多笔收支,供批量导入的复核表填充。仅服务器端(runtime="nodejs")。
 *
 * 三条识别链路(按扩展名分流,见 batch.ts 的 batchFileKind):
 *  - pdf   :pdf-parse 提纯文本 → 模型结构化抽取
 *  - image :银行 App / 网银的账单截图 → 多模态直读(detail:"high",小字才认得出)
 *  - text  :银行导出的 CSV / TXT 流水 → 直接当文本喂给模型(表头千奇百怪,交给模型比写死列名稳)
 *
 * 与 parsePdf.ts(抽「一笔」给表单自动填充)并存:那条链路服务「一张收据 = 一笔」,
 * 这条服务「一份流水 = 多笔」,提示词与 schema 都不同,不合并以免互相拖累准确率。
 */
// 直接引内部入口,绕开 pdf-parse 包顶层的 debug 自测(非 CommonJS 环境会去读测试 PDF 报错)。
// @ts-expect-error pdf-parse 内部入口没有类型声明
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import { getClient, getModel } from "@/lib/openai";
import { batchFileKind, MAX_BATCH_ROWS, normalizeBatchRows, type BatchRow } from "./batch";
import {
  EXPENSE_CATEGORY_PRESETS,
  INCOME_CATEGORY_PRESETS,
  PAYMENT_METHOD_PRESETS,
} from "./validate";

/** 材料读不出来(PDF 加密 / 空文件 / 不支持的类型)时抛出,路由层映射为用户提示 */
export class BatchParseError extends Error {}

export interface BatchFileInput {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** 文本上限:对账单动辄几十页,给足;超出部分截断(路由层会提示用户拆分)。 */
const MAX_TEXT = 60_000;
/** 识别一份材料给 3 分钟(几十行的对账单会比较慢),关掉 SDK 自动重试避免超时翻倍 */
const TIMEOUT_MS = 180_000;

function buildSystem(today: string): string {
  return `你是记账助手。用户会给你一份含【多笔】交易的材料(银行/信用卡对账单、网银或 App 的账单截图、导出的 CSV 流水)。
请把其中每一笔真实交易抽成一行,只输出符合 schema 的 JSON。

只抽真实发生的交易行。以下都不是交易,不要输出:表头、页眉页脚、页码、余额(Balance)、小计/合计(Total / Subtotal)、
账户信息、说明性文字、广告。若某行明确标注 Pending / 待入账,仍然抽出来,并在 note 里写「待入账」。

字段规则:
- type:钱出去 = expense(消费、扣款、取现、转出、Debit、Withdrawal、Payment、金额带负号或括号);
        钱进来 = income(存入、退款到账、转入、Deposit、Credit、正数金额)。
- amount:恒为正数,去掉负号、括号、货币符号与千分位逗号,最多两位小数(负号信息由 type 表达)。
- spentOn:该笔交易日期,严格 YYYY-MM-DD。原文只有 MM/DD 没有年份时,取「不晚于今天」的最近一个年份(今天是 ${today});
          日期确实读不出就留 ""。
- vendor:商家 / 对方名称,清掉门店号、城市州、参考号等噪音。例:「WAL-MART #2697 ANTIOCH CA 054634 07/27」→「Wal-Mart」。
- category:简短中文类别。尽量从这些里选——支出:${EXPENSE_CATEGORY_PRESETS.join(" / ")};收入:${INCOME_CATEGORY_PRESETS.join(" / ")}。
          都不合适再自己写一个简短的(如超市采购)。
- paymentMethod:尽量从这些里选:${PAYMENT_METHOD_PRESETS.join(" / ")}。Card / 刷卡但分不清借贷记时填「银行卡」;
          ACH / Transfer / Zelle → 银行转账;Check → 支票;Cash / ATM → 现金。拿不准留 ""。
- note:保留原始摘要(descriptor)、卡号后四位等可追溯信息,单条不超过 200 字。

不要编造不存在的信息;读不出的字段留空字符串。金额单位视为 USD。顺序按原文从上到下。最多输出 ${MAX_BATCH_ROWS} 行。`;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["income", "expense", ""] },
          spentOn: { type: "string" },
          amount: { type: "string" },
          category: { type: "string" },
          vendor: { type: "string" },
          paymentMethod: { type: "string" },
          note: { type: "string" },
        },
        required: ["type", "spentOn", "amount", "category", "vendor", "paymentMethod", "note"],
      },
    },
  },
  required: ["rows"],
} as const;

type UserContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "high" };

/** 把材料转成模型输入(文本 or 图片);内容为空返回 null。 */
async function buildUserContent(file: BatchFileInput): Promise<UserContent[] | null> {
  const kind = batchFileKind(file.name);
  if (!kind) throw new BatchParseError(`「${file.name}」类型不支持(仅 PDF / 图片 / CSV / TXT)。`);

  if (kind === "image") {
    const mime = file.mimeType && file.mimeType.startsWith("image/") ? file.mimeType : "image/png";
    const dataUrl = `data:${mime};base64,${file.bytes.toString("base64")}`;
    return [
      { type: "input_text", text: "这是一张账单/流水截图,请抽出其中每一笔交易。" },
      { type: "input_image", image_url: dataUrl, detail: "high" },
    ];
  }

  let text = "";
  if (kind === "pdf") {
    try {
      const r = await pdfParse(file.bytes);
      text = (r?.text ?? "").trim();
    } catch {
      throw new BatchParseError(`「${file.name}」PDF 解析失败,请确认文件未加密且内容可复制。`);
    }
  } else {
    text = file.bytes.toString("utf8").trim();
  }
  if (!text) return null;
  return [{ type: "input_text", text: text.slice(0, MAX_TEXT) }];
}

/**
 * 识别一份材料里的所有交易。返回空数组表示「读到了内容但没识别出交易」。
 * 材料本身读不出来(加密 PDF / 不支持的类型)抛 BatchParseError。
 */
export async function parseExpenseBatchFile(file: BatchFileInput, today: string): Promise<BatchRow[]> {
  const content = await buildUserContent(file);
  if (!content) return [];

  const client = getClient(TIMEOUT_MS, 0);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      { role: "system", content: buildSystem(today) },
      { role: "user", content },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "expense_batch_extract",
        strict: true,
        schema: SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const out = response.output_text;
  if (!out) return [];
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    return [];
  }
  return normalizeBatchRows(json);
}
