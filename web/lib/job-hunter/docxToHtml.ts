/**
 * 客户端把上传的 .docx / .html 简历转成「保留原格式」的 HTML 字符串。
 *
 * .docx 走 docx-preview 高保真渲染(保留字体/字号/颜色/版式,内联样式),而不是
 * mammoth(mammoth 只产语义 HTML、会丢格式)。这份 HTML 既用于页面内预览,也交给
 * 服务端做「保留格式的改写」(见 lib/job-hunter/align.ts / tailorFormat.ts)。
 *
 * 只能在浏览器里调用(用到 document、动态 import docx-preview)。
 */

import { hardenDocxStyles } from "./docxFonts";

export function isDocx(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(".docx") ||
    file.type.includes("wordprocessingml")
  );
}

export function isHtml(file: File): boolean {
  const n = file.name.toLowerCase();
  return n.endsWith(".html") || n.endsWith(".htm") || file.type === "text/html";
}

/** 用 docx-preview 把 .docx 高保真渲染成带内联样式的自包含 HTML(保留字体/字号/颜色/版式)。 */
export async function convertDocxToHtml(file: File): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const buf = await file.arrayBuffer();
  const content = document.createElement("div");
  const styleEl = document.createElement("div");
  content.style.cssText = "position:fixed;left:-99999px;top:0;width:816px";
  document.body.appendChild(content);
  document.body.appendChild(styleEl);
  try {
    await renderAsync(buf, content, styleEl, {
      className: "docx",
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
    });
    const css = styleEl.innerHTML; // <style>…</style> 块
    const bodyHtml = content.innerHTML;
    // Word 的字体名照搬进 CSS 会有两个坑:本机没装的字体(含 "Times New Roman Bold" 这种
    // 伪族名)整段打印不出来,Symbol/Wingdings 的项目符号变豆腐块。转换后立刻加固,
    // 页面预览和交给服务端改写的 HTML 就都是干净的。
    return hardenDocxStyles(
      `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${bodyHtml}</body></html>`,
    );
  } finally {
    content.remove();
    styleEl.remove();
  }
}

/** 把上传的 .docx / .html 统一转成 HTML 字符串(简历与模板共用)。 */
export async function fileToHtml(file: File): Promise<string> {
  if (isDocx(file)) return convertDocxToHtml(file);
  if (isHtml(file)) {
    const text = await file.text();
    if (!text.trim()) throw new Error("empty");
    return text;
  }
  throw new Error("unsupported");
}
