import mammoth from "mammoth";
// 直接引内部入口,绕开 pdf-parse 包顶层的 debug 自测(在非 CommonJS 环境会去读测试 PDF 而报错)。
// @ts-expect-error pdf-parse 内部入口没有类型声明
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** 文件类型不支持 / 解析失败时抛出,路由层映射为用户提示 */
export class FileParseError extends Error {}

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isPdf(file: File): boolean {
  return file.type === PDF_MIME || file.name.toLowerCase().endsWith(".pdf");
}

function isDocx(file: File): boolean {
  return (
    file.type === DOCX_MIME ||
    file.type.includes("wordprocessingml") ||
    file.name.toLowerCase().endsWith(".docx")
  );
}

/**
 * 把上传的 PDF / DOCX 文件解析为纯文本。
 * 不支持的类型、加密 / 扫描件(无文本)等情况抛出 FileParseError。
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());

  if (isPdf(file)) {
    let text = "";
    try {
      const result = await pdfParse(buf);
      text = (result?.text ?? "").trim();
    } catch {
      throw new FileParseError("PDF 解析失败,请确认文件未加密且内容可复制。");
    }
    if (!text) {
      throw new FileParseError("没能从该 PDF 提取到文字(可能是扫描件 / 图片版)。");
    }
    return text;
  }

  if (isDocx(file)) {
    let text = "";
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = (result?.value ?? "").trim();
    } catch {
      throw new FileParseError("Word 文档解析失败,请确认是 .docx 格式。");
    }
    if (!text) {
      throw new FileParseError("没能从该 Word 文档提取到文字。");
    }
    return text;
  }

  throw new FileParseError("仅支持 PDF 或 DOCX 文件。");
}
