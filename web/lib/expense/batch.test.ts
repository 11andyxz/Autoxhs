import { describe, expect, it } from "vitest";

import {
  batchFileKind,
  dupKey,
  isBatchAllowedFileName,
  markDuplicates,
  normalizeBatchRows,
  sumBatchRows,
  MAX_BATCH_ROWS,
  type BatchRow,
} from "./batch";

function row(p: Partial<BatchRow> = {}): BatchRow {
  return {
    type: "expense",
    spentOn: "2026-07-27",
    amount: "7.48",
    category: "超市采购",
    vendor: "County Market",
    paymentMethod: "银行卡",
    note: "",
    ...p,
  };
}

describe("batchFileKind / isBatchAllowedFileName", () => {
  it("按扩展名分流(大小写不敏感)", () => {
    expect(batchFileKind("statement.pdf")).toBe("pdf");
    expect(batchFileKind("IMG_1234.PNG")).toBe("image");
    expect(batchFileKind("screenshot.jpeg")).toBe("image");
    expect(batchFileKind("export.csv")).toBe("text");
    expect(batchFileKind("流水.txt")).toBe("text");
  });
  it("Word / 无扩展名 / 可执行文件不支持", () => {
    expect(batchFileKind("invoice.docx")).toBeNull();
    expect(batchFileKind("noext")).toBeNull();
    expect(batchFileKind("evil.sh")).toBeNull();
    expect(isBatchAllowedFileName("invoice.docx")).toBe(false);
    expect(isBatchAllowedFileName("a.pdf")).toBe(true);
  });
});

describe("normalizeBatchRows", () => {
  it("接受 {rows:[...]} 与裸数组两种形状", () => {
    const one = [{ type: "expense", spentOn: "2026-07-27", amount: "7.48", category: "x", vendor: "y", paymentMethod: "", note: "" }];
    expect(normalizeBatchRows({ rows: one })).toHaveLength(1);
    expect(normalizeBatchRows(one)).toHaveLength(1);
    expect(normalizeBatchRows(null)).toEqual([]);
    expect(normalizeBatchRows({ nope: 1 })).toEqual([]);
  });

  it("金额清洗:去掉货币符号/千分位,负号与括号都判为支出且金额转正", () => {
    const out = normalizeBatchRows([
      { type: "income", spentOn: "2026-07-27", amount: "−$7.48", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "income", spentOn: "2026-07-27", amount: "(22.04)", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "income", spentOn: "2026-07-27", amount: "$1,250.00", category: "", vendor: "", paymentMethod: "", note: "" },
    ]);
    expect(out.map((r) => [r.type, r.amount])).toEqual([
      ["expense", "7.48"],
      ["expense", "22.04"],
      ["income", "1250.00"],
    ]);
  });

  it("金额读不出的行直接丢弃(表头 / 余额行 / 空值)", () => {
    const out = normalizeBatchRows([
      { type: "", spentOn: "", amount: "", category: "", vendor: "Balance", paymentMethod: "", note: "" },
      { type: "expense", spentOn: "2026-07-27", amount: "abc", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "expense", spentOn: "2026-07-27", amount: "0", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "expense", spentOn: "2026-07-27", amount: "9.66", category: "", vendor: "", paymentMethod: "", note: "" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe("9.66");
  });

  it("非法日期留空(交给用户补),合法日期保留;type 缺失默认支出", () => {
    const out = normalizeBatchRows([
      { type: "", spentOn: "07/27", amount: "5", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "", spentOn: "2026-02-30", amount: "5", category: "", vendor: "", paymentMethod: "", note: "" },
      { type: "", spentOn: "2026-07-27", amount: "5", category: "", vendor: "", paymentMethod: "", note: "" },
    ]);
    expect(out.map((r) => r.spentOn)).toEqual(["", "", "2026-07-27"]);
    expect(out.every((r) => r.type === "expense")).toBe(true);
  });

  it("超长字段按各自上限截断,行数不超过上限", () => {
    const long = "x".repeat(5000);
    const [r] = normalizeBatchRows([{ type: "expense", spentOn: "2026-07-27", amount: "5", category: long, vendor: long, paymentMethod: long, note: long }]);
    expect(r.category).toHaveLength(100);
    expect(r.vendor).toHaveLength(255);
    expect(r.paymentMethod).toHaveLength(50);
    expect(r.note).toHaveLength(2000);

    const many = Array.from({ length: MAX_BATCH_ROWS + 30 }, () => ({ type: "expense", spentOn: "2026-07-27", amount: "1", category: "", vendor: "", paymentMethod: "", note: "" }));
    expect(normalizeBatchRows(many)).toHaveLength(MAX_BATCH_ROWS);
    expect(normalizeBatchRows(many, 5)).toHaveLength(5);
  });
});

describe("dupKey", () => {
  it("同日同额(不同写法)得到同一个键", () => {
    expect(dupKey({ spentOn: "2026-07-27", amount: "7.48" })).toBe("2026-07-27|7.48");
    expect(dupKey({ spentOn: "2026-07-27", amount: "7.4" })).toBe("2026-07-27|7.40");
    expect(dupKey({ spentOn: "2026-07-27", amount: 7.48 })).toBe("2026-07-27|7.48");
  });
  it("日期或金额缺失/非法时不参与去重", () => {
    expect(dupKey({ spentOn: "", amount: "7.48" })).toBe("");
    expect(dupKey({ spentOn: "07/27", amount: "7.48" })).toBe("");
    expect(dupKey({ spentOn: "2026-07-27", amount: "" })).toBe("");
  });
});

describe("markDuplicates", () => {
  it("命中库里已有的键 → duplicate", () => {
    const out = markDuplicates([row(), row({ amount: "18.08" })], ["2026-07-27|7.48"]);
    expect(out.map((r) => r.duplicate)).toEqual([true, false]);
  });
  it("本批次内重复:第一条正常,后面的标重复", () => {
    const out = markDuplicates([row(), row(), row({ amount: "18.08" })], []);
    expect(out.map((r) => r.duplicate)).toEqual([false, true, false]);
  });
  it("日期缺失的行永远不判重复(键为空)", () => {
    const out = markDuplicates([row({ spentOn: "" }), row({ spentOn: "" })], []);
    expect(out.map((r) => r.duplicate)).toEqual([false, false]);
  });
  it("不修改入参", () => {
    const rows = [row()];
    markDuplicates(rows, ["2026-07-27|7.48"]);
    expect(rows[0]).not.toHaveProperty("duplicate");
  });
});

describe("sumBatchRows", () => {
  it("按类型分别累计,净额 = 收入 - 支出", () => {
    const t = sumBatchRows([
      row({ amount: "7.48" }),
      row({ amount: "18.08" }),
      row({ type: "income", amount: "100" }),
    ]);
    expect(t).toEqual({ income: 100, expense: 25.56, net: 74.44 });
  });
  it("非法金额不计入(用户改坏了某一格也不会让合计变 NaN)", () => {
    expect(sumBatchRows([row({ amount: "abc" }), row({ amount: "10" })])).toEqual({ income: 0, expense: 10, net: -10 });
  });
});
