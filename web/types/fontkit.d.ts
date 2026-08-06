/**
 * fontkit 没带类型声明。这里只声明我们真正用到的那一点点:
 * 「编辑 PDF 内容」写中文时,把 fontkit 交给 pdf-lib 做字体子集
 * (见 lib/pdfTools/pdfEditApply.ts 的 adaptFontkit —— 它只需要 create())。
 */
declare module "fontkit" {
  export function create(bytes: Uint8Array, postscriptName?: string): unknown;
  const fontkit: { create: typeof create };
  export default fontkit;
}
