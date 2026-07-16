import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import puppeteer from "puppeteer-core";

import { inlineFieldHyperlinks } from "./inlineFieldHyperlinks";

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

type PageSize = "letter" | "a4";

/**
 * 打印用样式。渲染改用 docx-preview:它从 .docx 里读出**真实**的字体/字号/对齐/行距/页边距,
 * 高保真还原 Word 版式(与页面上的预览一致),不像 mammoth 那样丢掉所有格式。
 *
 * docx-preview 会给每一「页」生成一个 section.docx,自带该文档的页边距(padding)与页宽(width),
 * 并在外层 .docx-wrapper 加灰底/内边距/阴影(供屏幕预览)。打印时:
 *  - 去掉 wrapper 的灰底/内边距,以及 section 的阴影 —— 否则会和文档自身页边距叠加、页面发灰;
 *  - @page margin:0 + section 自带的 padding 提供页边距,得到与 Word/WPS 打印一致的边距
 *    (旧实现用 mammoth 无格式 HTML + 硬编码 1in 页边距,是「变丑」的主因)。
 */
export function buildPrintCss(pageSize: PageSize): string {
  const size = pageSize === "a4" ? "A4" : "letter";
  return `:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: #fff; }
.docx-wrapper { background: #fff !important; padding: 0 !important; }
.docx-wrapper > section.docx { box-shadow: none !important; margin: 0 auto !important; }
@page { size: ${size}; margin: 0; }`;
}

/** 打印页初始骨架:只含打印样式与空 body,docx-preview 稍后把内容注入进来。 */
export function buildShellHtml(pageSize: PageSize): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${buildPrintCss(pageSize)}</style>
</head>
<body></body>
</html>`;
}

// docx-preview 渲染选项:保留原版式,图片内联为 base64(避免 blob URL 在无头打印时的时序/生命周期问题),
// 忽略「上次渲染的分页符」以免多出空白页。
const RENDER_OPTIONS = {
  className: "docx",
  inWrapper: true,
  ignoreLastRenderedPageBreak: true,
  useBase64URL: true,
} as const;

export type NormalizedFontFamily = {
  value: string;
  bold: boolean;
  italic: boolean;
  changed: boolean;
};

/**
 * 归一 docx-preview 生成的 font-family,修掉两类会让文字在 macOS 无头 Chrome **打印时整段丢失**的问题:
 *
 * 1) 「脸名当族名」:"<字体> Bold" / "<字体> Italic" / "<字体> Bold Italic"(本文档就有 33 处
 *    "Times New Roman Bold")。Word/WPS 会归一到基础族 + 字重,无头 Chrome 却无法嵌入这种族名 → 空白。
 *    还原成基础族,字重/字型改由 font-weight / font-style 承载。
 * 2) 「不可嵌入的中文族」:如 宋体(SimSun)/微软雅黑/PingFang/Hiragino。docx 常给拉丁文本也挂上东亚字体
 *    (w:hint="eastAsia"),这些族在无头 Chrome 里回退到 PingFang 等**无法嵌入打印**的字体 → 拉丁文也丢。
 *    统一换成 "Heiti SC"(本仓库既有约定:黑体可正常嵌入);若中文族是首选(前面没有可嵌入的拉丁族),
 *    再把文档主拉丁族(baseLatin)补到最前,拉丁文才保持原本的(衬线)字体、与全文一致。
 *
 * 注意:此函数会被 .toString() 注入到无头页面里执行,必须**自包含**——不要引用模块作用域的任何变量。
 */
export function normalizeFontFamily(
  fontFamily: string,
  baseLatin?: string,
): NormalizedFontFamily {
  const faceSuffix = /\s+(bold italic|italic bold|bold oblique|oblique bold|bold|italic|oblique)$/i;
  // 在 macOS 无头 Chrome 打印里无法可靠嵌入的中文族(会回退到 PingFang/Hiragino 而丢字形)
  const cjkNonEmbed =
    /^(宋体|新宋体|仿宋|仿宋_gb2312|楷体|楷体_gb2312|黑体|华文[一-鿿]*|微软雅黑|simsun|nsimsun|simhei|kaiti|fangsong|microsoft\s*yahei|microsoft\s*jhenghei|pingfang(\s*sc|\s*tc|\s*hk)?|hiragino[\w\s]*)$/i;
  const HEITI = '"Heiti SC"';
  let bold = false;
  let italic = false;
  let changed = false;
  const out: string[] = [];
  for (const raw of fontFamily.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    let bare = token.replace(/^["']|["']$/g, "");
    const m = faceSuffix.exec(bare);
    if (m) {
      changed = true;
      const suffix = m[1].toLowerCase();
      if (suffix.indexOf("bold") >= 0) bold = true;
      if (suffix.indexOf("italic") >= 0 || suffix.indexOf("oblique") >= 0) italic = true;
      bare = bare.slice(0, bare.length - m[0].length).trim();
    }
    if (cjkNonEmbed.test(bare)) {
      changed = true;
      out.push(HEITI);
      continue;
    }
    out.push(/\s/.test(bare) ? `"${bare}"` : bare);
  }
  if (out.length > 0 && out[0] === HEITI && baseLatin) {
    out.unshift(baseLatin);
    changed = true;
  }
  const deduped = out.filter((v, i) => i === 0 || v !== out[i - 1]);
  return { value: deduped.join(", "), bold, italic, changed };
}

// docx-preview 的 UMD 走浏览器全局分支:设 globalThis.docx,并读取 globalThis.JSZip。
// 所以必须先加载 jszip(设好全局 JSZip),再加载 docx-preview。两个都是自包含的 UMD 构建。
// 只在本机 dev 使用(需要本机 Chrome),从 node_modules 直接读盘即可;懒加载 + 缓存。
let cachedScripts: { jszip: string; docxPreview: string } | null = null;
function loadBrowserScripts(): { jszip: string; docxPreview: string } {
  if (cachedScripts) return cachedScripts;
  const read = (rel: string): string => {
    const p = path.join(process.cwd(), "node_modules", rel);
    return fs.readFileSync(p, "utf8");
  };
  cachedScripts = {
    jszip: read("jszip/dist/jszip.min.js"),
    docxPreview: read("docx-preview/dist/docx-preview.min.js"),
  };
  return cachedScripts;
}

/**
 * 打印前预处理 docx:把「复杂域超链接」(HYPERLINK complex field)改写成原生 <w:hyperlink>,
 * 否则 docx-preview 会把含 fldChar/instrText 的 run 整段丢弃 —— 本仓库那份简历里,邮箱的
 * "@gmail.com" 与整条 LinkedIn URL 因结束符和显示文本同处一个 run 而在 PDF 里消失。
 * 任何异常都回退到原始 docx(绝不让预处理把结果变得更糟)。
 */
async function preprocessDocx(buf: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const docFile = zip.file("word/document.xml");
    if (!docFile) return buf;
    const documentXml = await docFile.async("string");
    const relsFile = zip.file("word/_rels/document.xml.rels");
    const relsXml = relsFile ? await relsFile.async("string") : null;

    const res = inlineFieldHyperlinks(documentXml, relsXml);
    if (!res.changed) return buf;

    zip.file("word/document.xml", res.documentXml);
    if (res.relsXml != null) zip.file("word/_rels/document.xml.rels", res.relsXml);
    return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  } catch (e) {
    console.error("[word-to-pdf] 超链接预处理失败,使用原始 docx:", e);
    return buf;
  }
}

// 串行执行 Chrome 打印,避免并发请求同时拉起多个 Chrome
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task);
  chain = result.catch(() => undefined);
  return result;
}

async function renderDocxToPdf(buf: Buffer, pageSize: PageSize): Promise<Buffer> {
  const executablePath = resolveChromePath(
    (p) => fs.existsSync(p),
    process.env.CHROME_EXECUTABLE_PATH,
  );
  if (!executablePath) throw new ChromeNotFoundError();

  const { jszip, docxPreview } = loadBrowserScripts();
  const processed = await preprocessDocx(buf);
  const docxBase64 = processed.toString("base64");

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(buildShellHtml(pageSize), { waitUntil: "load", timeout: 30000 });

    // 先 JSZip 后 docx-preview(UMD 加载时即读取全局 JSZip)
    await page.addScriptTag({ content: jszip });
    await page.addScriptTag({ content: docxPreview });

    // 在页面里用 docx-preview 渲染:内容注入 body,样式注入 head。
    await page.evaluate(
      async (base64: string, options: Record<string, unknown>) => {
        const g = globalThis as unknown as {
          atob: (s: string) => string;
          docx?: {
            renderAsync: (
              data: ArrayBuffer | Uint8Array,
              body: HTMLElement,
              style: HTMLElement | undefined,
              opts: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        };
        if (!g.docx?.renderAsync) throw new Error("docx-preview 未加载");
        const binary = g.atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const styleEl = document.createElement("div");
        document.head.appendChild(styleEl);
        await g.docx.renderAsync(bytes, document.body, styleEl, options);
      },
      docxBase64,
      RENDER_OPTIONS as unknown as Record<string, unknown>,
    );

    // 归一字体,否则「脸名当族名」与「不可嵌入的中文族」的文字在无头打印的 PDF 里会整段丢失。
    // 复用同一份 normalizeFontFamily(注入其源码),对内联样式与样式表规则各扫一遍。
    await page.addScriptTag({
      content: `globalThis.__docxNormalizeFF = ${normalizeFontFamily.toString()};`,
    });
    await page.evaluate(() => {
      const normalize = (
        globalThis as unknown as { __docxNormalizeFF: typeof normalizeFontFamily }
      ).__docxNormalizeFF;

      // 文档主拉丁族:内联 font-family 里出现最多的、非中文的首选族(本文档为 Times New Roman)。
      // 用于把「以中文族为首选」的拉丁文本补回正确的衬线字体,和全文保持一致。
      const isCjk = /[一-鿿㐀-䶵豈-﫿]/;
      const tally = new Map<string, number>();
      document.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
        const ff = el.style.fontFamily;
        if (!ff) return;
        const first = ff.split(",")[0].trim();
        const bare = first.replace(/^["']|["']$/g, "");
        if (!bare || isCjk.test(bare) || / (bold|italic|oblique)$/i.test(bare)) return;
        tally.set(first, (tally.get(first) || 0) + 1);
      });
      let baseLatin = "";
      let best = 0;
      tally.forEach((n, k) => {
        if (n > best) {
          best = n;
          baseLatin = k;
        }
      });

      const fix = (style: CSSStyleDeclaration) => {
        const ff = style.fontFamily;
        if (!ff) return;
        const r = normalize(ff, baseLatin || undefined);
        if (!r.changed) return;
        style.fontFamily = r.value;
        const w = style.fontWeight;
        if (r.bold && (!w || w === "normal" || w === "400")) style.fontWeight = "bold";
        if (r.italic && (!style.fontStyle || style.fontStyle === "normal"))
          style.fontStyle = "italic";
      };
      // docx-preview 用 p.docx-num-*::before { content:"<符号>\t"; font-family:Symbol|Wingdings }
      // 渲染项目符号。符号字体里的 PUA 码位(如 Symbol U+F0B7、Wingdings U+F0A7)在无头 Chrome 里
      // 无法嵌入,打印成空心方框(tofu)。把这类符号项目符号换成真正的 Unicode 字符(•/▪),并让它用
      // 正文字体(Times New Roman 等有这些字形,且可正常嵌入),数字/字母编号(非符号字体)不动。
      const fixBullet = (rule: CSSStyleRule) => {
        const sel = rule.selectorText || "";
        if (!sel.includes("::before")) return;
        const fam = (rule.style.fontFamily || "").toLowerCase();
        let glyph = "";
        if (fam.includes("symbol")) glyph = "•"; // •
        else if (fam.includes("wingdings")) glyph = "▪"; // ▪
        if (!glyph) return;
        rule.style.setProperty("content", `"${glyph}\\9 "`); // 符号 + 制表符(保留与文字的间距)
        rule.style.removeProperty("font-family"); // 继承正文字体,符号才能正常显示/嵌入
      };
      document.querySelectorAll<HTMLElement>("[style]").forEach((el) => fix(el.style));
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            const cssRule = rule as CSSStyleRule;
            if (cssRule.style) {
              fix(cssRule.style);
              fixBullet(cssRule);
            }
          }
        } catch {
          /* 跨源样式表读不到 cssRules,忽略 */
        }
      }
    });

    // 等字体就绪,避免用回退字体测量/排版
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);

    // @page 已定义纸张与 margin:0;preferCSSPageSize 让其生效,section 自带的 padding 提供页边距。
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function docxToPdf(
  buf: Buffer,
  opts?: { pageSize?: PageSize },
): Promise<Buffer> {
  const pageSize: PageSize = opts?.pageSize === "a4" ? "a4" : "letter";
  return enqueue(() => renderDocxToPdf(buf, pageSize));
}
