import ExcelJS from "exceljs";
import { type NextRequest, NextResponse } from "next/server";

import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS = 5000;

/** 把 exceljs 的 cell.value(可能是富文本/超链接/公式对象)取成纯文本。 */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  const o = v as { richText?: Array<{ text?: string }>; text?: string; result?: unknown; hyperlink?: string };
  if (Array.isArray(o.richText)) return o.richText.map((t) => t.text ?? "").join("");
  if (typeof o.text === "string") return o.text;
  if (o.result != null) return cellText(o.result as ExcelJS.CellValue);
  return "";
}

/** 上传面试题库 Excel → 解析出「问题/答案/大类/分类/星级」行(不落库,前端筛选后再导入)。 */
export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return bad("请求格式有误。");
  }
  if (!file) return bad("没有收到文件。");
  if (!file.name.toLowerCase().endsWith(".xlsx")) return bad("请上传 .xlsx 文件。");
  if (file.size > MAX_FILE_BYTES) return bad("文件太大了（上限 15MB）。");

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    // @types/node 的 Buffer 泛型与 exceljs 声明不完全一致,这里安全转型。
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    // 优先名为「面试题库」的表,否则用第一张有内容的表。
    const ws =
      wb.worksheets.find((w) => w.name.includes("题库")) ??
      wb.worksheets.find((w) => w.actualRowCount > 1) ??
      wb.worksheets[0];
    if (!ws) return bad("这个表里没有数据。");

    // 表头行:按列名定位。
    const header = ws.getRow(1);
    const col: Record<string, number> = {};
    header.eachCell((cell, c) => {
      const name = cellText(cell.value).trim();
      if (name) col[name] = c;
    });
    const qCol = col["问题"] ?? col["题目"] ?? col["question"] ?? col["Question"];
    const aCol = col["答案"] ?? col["answer"] ?? col["Answer"];
    const majorCol = col["大类"] ?? col["类别"];
    const catCol = col["分类"] ?? col["小类"];
    const starTextCol = col["星星"];
    const starNumCol = col["星数"] ?? col["星级"];
    if (!qCol) return bad("没找到「问题」列，请确认这是面试题库的 Excel。");

    const rows: Array<{ question: string; answer: string; major: string; category: string; stars: number }> = [];
    for (let rn = 2; rn <= ws.rowCount && rows.length < MAX_ROWS; rn++) {
      const row = ws.getRow(rn);
      const question = cellText(row.getCell(qCol).value).trim();
      if (!question) continue;
      const answer = aCol ? cellText(row.getCell(aCol).value).trim() : "";
      const major = majorCol ? cellText(row.getCell(majorCol).value).trim() : "";
      const category = catCol ? cellText(row.getCell(catCol).value).trim() : "";
      const starText = starTextCol ? cellText(row.getCell(starTextCol).value) : "";
      const starMatches = starText.match(/★/g);
      const stars = starMatches
        ? starMatches.length
        : starNumCol
          ? Math.max(0, Math.min(5, Math.round(Number(cellText(row.getCell(starNumCol).value)) || 0)))
          : 0;
      rows.push({
        question: question.slice(0, 2000),
        answer: answer.slice(0, 8000),
        major: major.slice(0, 60),
        category: category.slice(0, 60),
        stars,
      });
    }
    if (!rows.length) return bad("没解析到任何题目。");
    return NextResponse.json({ success: true, rows, total: rows.length });
  } catch (err) {
    return fail(err, "cram-xlsx");
  }
}
