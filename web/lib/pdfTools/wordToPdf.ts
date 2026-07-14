import fs from "node:fs";

import mammoth from "mammoth";
import puppeteer from "puppeteer-core";

/** 本机未装 Chrome/Chromium 时抛出,路由层据此返回 503 */
export class ChromeNotFoundError extends Error {
  constructor() {
    super("未找到本机 Chrome,无法执行 Word→PDF。");
    this.name = "ChromeNotFoundError";
  }
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

/** 按 env → Chrome → Chromium 顺序找第一个存在的可执行文件;找不到返回 null。exists 可注入便于测试 */
export function resolveChromePath(exists: (p: string) => boolean, env?: string): string | null {
  const candidates = env ? [env, ...CHROME_CANDIDATES] : [...CHROME_CANDIDATES];
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

/** 把 mammoth 输出的 body HTML 包成可打印的完整页面(mammoth 输出视为可信,不转义) */
export function buildPrintHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* 注意:macOS 无头 Chrome 打印 PDF 时 PingFang/Hiragino 的字形无法嵌入(中文会整段丢失),
     Heiti SC 可正常嵌入,须排在它们之前 */
  body {
    font-family: Calibri, "Helvetica Neue", Arial, "Heiti SC", "PingFang SC", "Hiragino Sans GB", sans-serif;
    font-size: 11pt;
    line-height: 1.5;
  }
  h1 { font-size: 20pt; margin: 0.6em 0 0.4em; }
  h2 { font-size: 16pt; margin: 0.6em 0 0.4em; }
  h3 { font-size: 13pt; margin: 0.6em 0 0.4em; }
  h4 { font-size: 12pt; margin: 0.6em 0 0.4em; }
  h5 { font-size: 11pt; margin: 0.6em 0 0.4em; }
  h6 { font-size: 10pt; margin: 0.6em 0 0.4em; }
  p { margin: 0 0 0.6em; }
  ul, ol { padding-left: 2em; }
  table { border-collapse: collapse; width: auto; }
  td, th { border: 1px solid #999; padding: 4px 8px; }
  img { max-width: 100%; height: auto; }
  pre, code { font-family: "SF Mono", Menlo, Consolas, monospace; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

// 串行执行 Chrome 打印,避免并发请求同时拉起多个 Chrome
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task);
  chain = result.catch(() => undefined);
  return result;
}

async function printHtmlToPdf(html: string, format: "A4" | "Letter"): Promise<Buffer> {
  const executablePath = resolveChromePath(
    (p) => fs.existsSync(p),
    process.env.CHROME_EXECUTABLE_PATH,
  );
  if (!executablePath) throw new ChromeNotFoundError();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    // puppeteer-core 25 的 setContent 不再支持 networkidle0;图片均为内联 data: URI,load 已足够
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    const pdf = await page.pdf({
      format,
      printBackground: true,
      margin: { top: "1in", right: "1in", bottom: "1in", left: "1in" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function docxToPdf(
  buf: Buffer,
  opts?: { pageSize?: "letter" | "a4" },
): Promise<Buffer> {
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf });
  if (messages.length > 0) console.debug("[pdfTools/wordToPdf] mammoth messages", messages);
  const fullHtml = buildPrintHtml(html);
  const format = opts?.pageSize === "a4" ? "A4" : "Letter";
  return enqueue(() => printHtmlToPdf(fullHtml, format));
}
