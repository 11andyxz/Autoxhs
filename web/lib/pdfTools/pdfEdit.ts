/**
 * 「PDF 内容编辑」的纯逻辑层(无 DOM、无 pdfjs / pdf-lib 依赖,可单测)。
 *
 * 设计要点:
 *  - 所有几何量统一用 **PDF 用户空间的点(pt)**:x 向右、y 向上、原点在页面左下角,
 *    和 pdf-lib 的绘制坐标一致。UI 只在显示时经视口矩阵换算成百分比,导出不再做二次换算,
 *    避免「预览对了导出偏了」这类两套坐标系的老问题(签名 tab 用的是左上角比例,不复用)。
 *  - 页面旋转:原始 /Rotate 由 pdfjs 视口矩阵吸收;用户新加的旋转只作为增量记录,
 *    显示端用 CSS 旋转整块(位图 + 覆盖层一起转),所以覆盖层内部坐标永远是「未旋转」的。
 */

export type Family = "sans" | "serif" | "mono";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** pdfjs 的字体信息(commonObjs 里的 FontFaceObject + textContent.styles 合并而来)。 */
export interface FontMeta {
  /** 真实 BaseFont 名,如 "Helvetica-Bold"、"ABCDEE+Calibri" */
  name?: string;
  /** pdfjs 的兜底族:serif / sans-serif / monospace */
  fallback?: string;
  bold?: boolean;
  italic?: boolean;
  /** 相对字号的比例(如 0.718) */
  ascent?: number;
  descent?: number;
}

/** 从 pdfjs textContent 抽出的单个文本片段(已换算到 pt)。 */
export interface RawTextItem {
  str: string;
  /** 片段左端 x(pt) */
  x: number;
  /** 基线 y(pt,向上为正) */
  y: number;
  width: number;
  /** 近似字号(pt) */
  height: number;
  fontName?: string;
}

/** 可编辑的一段文字(同一行、同一样式、水平连续)。 */
export interface TextBlock {
  id: string;
  page: number;
  text: string;
  x: number;
  baseline: number;
  width: number;
  size: number;
  bold: boolean;
  italic: boolean;
  family: Family;
  /** 相对字号的比例,用于算遮盖框高度 */
  ascent: number;
  descent: number;
}

export const DEFAULT_ASCENT = 0.75;
export const DEFAULT_DESCENT = -0.22;

/* ========== 矩阵(pdfjs 视口变换) ========== */

/** [a, b, c, d, e, f]:x' = a·x + c·y + e,y' = b·x + d·y + f */
export type Mat = readonly [number, number, number, number, number, number];

export function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMat(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) throw new Error("invertMat: 矩阵不可逆");
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function applyInvMat(m: Mat, x: number, y: number): [number, number] {
  return applyMat(invertMat(m), x, y);
}

/* ========== 显示端坐标 ========== */

export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 屏幕坐标 → 元素内部(未旋转)归一化坐标。
 * box 是元素经 CSS `rotate(rotate)` 之后的外接矩形(90/270 度时宽高已互换)。
 * 返回值是 0~1 的比例(可能越界,由调用方裁剪)。
 */
export function screenToLocalFraction(
  box: ScreenBox,
  rotate: number,
  clientX: number,
  clientY: number,
): { fx: number; fy: number } {
  const rot = ((rotate % 360) + 360) % 360;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  // CSS 正角度是顺时针(y 轴向下),反向旋转即可回到未旋转的元素坐标系
  const rad = (-rot * Math.PI) / 180;
  const ux = dx * Math.cos(rad) - dy * Math.sin(rad);
  const uy = dx * Math.sin(rad) + dy * Math.cos(rad);
  // 未旋转时的元素尺寸:90/270 度要把外接矩形的宽高换回来
  const w = rot === 90 || rot === 270 ? box.height : box.width;
  const h = rot === 90 || rot === 270 ? box.width : box.height;
  return { fx: ux / w + 0.5, fy: uy / h + 0.5 };
}

/* ========== 文本片段 → 可编辑块 ========== */

const BOLD_RE = /bold|black|heavy|semib|demi/i;
const ITALIC_RE = /italic|oblique/i;
const SERIF_RE = /times|georgia|garamond|book|roman|serif|song|ming|宋|楷|kai/i;
const MONO_RE = /courier|mono|consol/i;

export function familyFromMeta(meta: FontMeta | undefined): Family {
  const name = meta?.name ?? "";
  if (MONO_RE.test(name)) return "mono";
  if (SERIF_RE.test(name)) return "serif";
  if (name) return "sans";
  const fb = meta?.fallback ?? "";
  if (/mono/i.test(fb)) return "mono";
  if (/serif/i.test(fb) && !/sans/i.test(fb)) return "serif";
  return "sans";
}

function styleOf(meta: FontMeta | undefined): { bold: boolean; italic: boolean; family: Family } {
  const name = meta?.name ?? "";
  return {
    bold: meta?.bold ?? BOLD_RE.test(name),
    italic: meta?.italic ?? ITALIC_RE.test(name),
    family: familyFromMeta(meta),
  };
}

export interface GroupOptions {
  /** 同一行内水平间隙超过这么多个 em 就切成两块(表单里「标签  值」要能分开点) */
  splitEm?: number;
  /** 间隙超过这么多个 em 就在块内补一个空格 */
  spaceEm?: number;
}

/**
 * 把 pdfjs 的文本片段聚成「可点击编辑的块」。
 *
 * 注意:没有复用 pdfToWord 的 `groupIntoLines` —— 那个是为「还原成 Word 段落」设计的,
 * 会把整条视觉行(含左右相隔很远的两个表单字段)并成一个 Line 且丢掉片段位置;
 * 编辑场景需要按水平间隙/样式切块,并保留每块自己的 x / 宽度用来定位遮盖框。
 */
export function groupIntoBlocks(
  items: RawTextItem[],
  fonts: Map<string, FontMeta> = new Map(),
  pageIndex = 0,
  opts: GroupOptions = {},
): TextBlock[] {
  const splitEm = opts.splitEm ?? 1.1;
  const spaceEm = opts.spaceEm ?? 0.22;
  // pdfjs 会插入宽度很大但内容是空白的「间隙填充项」(height=0),它们不参与成块
  const usable = items.filter((it) => it.str.trim().length > 0 && it.height > 0);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);

  // 1) 按基线聚成视觉行
  const lines: RawTextItem[][] = [];
  for (const it of sorted) {
    const cur = lines[lines.length - 1];
    if (cur) {
      const refY = cur.reduce((s, m) => s + m.y, 0) / cur.length;
      const tol = Math.max(2, 0.4 * Math.max(it.height, cur[0].height));
      if (Math.abs(it.y - refY) < tol) {
        cur.push(it);
        continue;
      }
    }
    lines.push([it]);
  }

  // 2) 行内按 x 排序,遇到大间隙或样式切换就断块
  const blocks: TextBlock[] = [];
  for (const line of lines) {
    const row = [...line].sort((a, b) => a.x - b.x);
    let cur: { items: RawTextItem[]; style: ReturnType<typeof styleOf>; text: string } | null = null;
    const flush = () => {
      if (!cur) return;
      const first = cur.items[0];
      const last = cur.items[cur.items.length - 1];
      const size =
        cur.items.reduce((s, m) => s + m.height * Math.max(m.str.length, 1), 0) /
        cur.items.reduce((s, m) => s + Math.max(m.str.length, 1), 0);
      const meta = fonts.get(first.fontName ?? "");
      blocks.push({
        id: `p${pageIndex}b${blocks.length}`,
        page: pageIndex,
        text: cur.text,
        x: first.x,
        baseline: cur.items.reduce((s, m) => s + m.y, 0) / cur.items.length,
        width: Math.max(last.x + last.width - first.x, 1),
        size: Math.round(size * 100) / 100,
        bold: cur.style.bold,
        italic: cur.style.italic,
        family: cur.style.family,
        ascent: meta?.ascent ?? DEFAULT_ASCENT,
        descent: meta?.descent ?? DEFAULT_DESCENT,
      });
      cur = null;
    };
    for (const it of row) {
      const style = styleOf(fonts.get(it.fontName ?? ""));
      if (cur) {
        const prev = cur.items[cur.items.length - 1];
        const em = Math.max(prev.height, it.height) || 12;
        const gap = it.x - (prev.x + prev.width);
        const sameStyle =
          cur.style.bold === style.bold &&
          cur.style.italic === style.italic &&
          cur.style.family === style.family &&
          Math.abs(prev.height - it.height) < 0.12 * em;
        if (gap > splitEm * em || !sameStyle) {
          flush();
        } else {
          const needSpace =
            gap > spaceEm * em && !cur.text.endsWith(" ") && !it.str.startsWith(" ");
          cur.items.push(it);
          cur.text += (needSpace ? " " : "") + it.str;
          continue;
        }
      }
      cur = { items: [it], style, text: it.str };
    }
    flush();
  }
  return blocks;
}

/* ========== 几何 ========== */

export interface Rect {
  /** 左下角(pt) */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个文本块的遮盖框(pt,左下角原点)。pad 单位是 pt。 */
export function blockBox(block: TextBlock, pad = 0.6): Rect {
  const asc = block.ascent > 0 ? block.ascent : DEFAULT_ASCENT;
  const desc = block.descent < 0 ? block.descent : DEFAULT_DESCENT;
  return {
    x: block.x - pad,
    y: block.baseline + desc * block.size - pad,
    w: block.width + pad * 2,
    h: (asc - desc) * block.size + pad * 2,
  };
}

/* ========== 字体选择 ========== */

/** pdf-lib StandardFonts 的取值(14 种内置字体里的 12 个文字字体)。 */
export type StandardFontKey =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique";

export function fontKeyFor(family: Family, bold: boolean, italic: boolean): StandardFontKey {
  if (family === "serif") {
    if (bold && italic) return "Times-BoldItalic";
    if (bold) return "Times-Bold";
    if (italic) return "Times-Italic";
    return "Times-Roman";
  }
  if (family === "mono") {
    if (bold && italic) return "Courier-BoldOblique";
    if (bold) return "Courier-Bold";
    if (italic) return "Courier-Oblique";
    return "Courier";
  }
  if (bold && italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/** 浏览器里预览用的 CSS 字体族(尽量贴近导出所用的内置字体)。 */
export function cssFontFamily(family: Family): string {
  if (family === "serif") return '"Times New Roman", Times, serif';
  if (family === "mono") return '"Courier New", Courier, monospace';
  return 'Helvetica, Arial, "Helvetica Neue", sans-serif';
}

// WinAnsi(内置字体的编码)能表示的、码位大于 0xFF 的字符
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
  0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** true = 内置字体画不出来(有中文等),必须嵌入 Unicode 字体。 */
export function needsUnicodeFont(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09) continue;
    if (code >= 0x20 && code <= 0xff) continue;
    if (WIN_ANSI_EXTRA.has(code)) continue;
    return true;
  }
  return false;
}

/** 粗略估算文本宽度(pt):中日韩全角按 1em,其余按 0.5em。仅用于没有真字体度量时的兜底。 */
export function estimateWidthPt(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    em += c > 0x2e7f ? 1 : c === 0x20 ? 0.28 : 0.52;
  }
  return em * size;
}

/**
 * 让文本塞进原来的宽度:只缩不放,最多缩到 minRatio 倍。
 * measure 传入真实字体度量(pdf-lib 的 widthOfTextAtSize)时结果与导出完全一致。
 */
export function fitTextSize(
  text: string,
  size: number,
  maxWidth: number,
  measure: (text: string, size: number) => number,
  minRatio = 0.55,
): number {
  if (!text || maxWidth <= 0) return size;
  const w = measure(text, size);
  if (w <= maxWidth) return size;
  const scaled = (size * maxWidth) / w;
  const floor = size * minRatio;
  return Math.round(Math.max(scaled, floor) * 100) / 100;
}

/* ========== 页面顺序 / 旋转 ========== */

export interface PageSlot {
  /** 源文档里的页序号(0 起) */
  src: number;
  /** 相对源页的旋转增量(度,90 的倍数) */
  rotate: number;
}

export function movePageSlot(pages: PageSlot[], index: number, dir: -1 | 1): PageSlot[] {
  const to = index + dir;
  if (index < 0 || index >= pages.length || to < 0 || to >= pages.length) return pages;
  const next = [...pages];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function deletePageSlot(pages: PageSlot[], index: number): PageSlot[] {
  if (pages.length <= 1 || index < 0 || index >= pages.length) return pages;
  return pages.filter((_, i) => i !== index);
}

export function rotatePageSlot(pages: PageSlot[], index: number, delta: number): PageSlot[] {
  if (index < 0 || index >= pages.length) return pages;
  return pages.map((p, i) =>
    i === index ? { ...p, rotate: (((p.rotate + delta) % 360) + 360) % 360 } : p,
  );
}

/* ========== 取色(遮盖底色 / 文字色) ========== */

function lum(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * 在渲染好的页面位图里,按框取「文字色」和「底色」。
 * 遮盖用底色(而不是死白)能在浅灰/彩色底的表单上不留白块;文字色让改写后的字和原文一致。
 * rgba 是 imgW×imgH 的 RGBA 数组,box 单位是位图像素。
 */
export function sampleColors(
  rgba: Uint8ClampedArray | Uint8Array,
  imgW: number,
  imgH: number,
  box: { x: number; y: number; w: number; h: number },
): { ink: RGB; bg: RGB } {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(imgW, Math.ceil(box.x + box.w));
  const y1 = Math.min(imgH, Math.ceil(box.y + box.h));
  const px: Array<{ r: number; g: number; b: number; l: number }> = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * imgW + x) * 4;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      px.push({ r, g, b, l: lum(r, g, b) });
    }
  }
  const white: RGB = { r: 1, g: 1, b: 1 };
  const black: RGB = { r: 0.1, g: 0.1, b: 0.1 };
  if (px.length === 0) return { ink: black, bg: white };
  px.sort((a, b) => a.l - b.l);
  const darkN = Math.max(1, Math.round(px.length * 0.1));
  const brightN = Math.max(1, Math.round(px.length * 0.35));
  const mean = (arr: typeof px): RGB => ({
    r: arr.reduce((s, p) => s + p.r, 0) / arr.length / 255,
    g: arr.reduce((s, p) => s + p.g, 0) / arr.length / 255,
    b: arr.reduce((s, p) => s + p.b, 0) / arr.length / 255,
  });
  const ink = mean(px.slice(0, darkN));
  const bg = mean(px.slice(px.length - brightN));
  // 框里几乎没有深浅差(比如空白处)时,不要把噪点当文字色
  const contrast = lum(bg.r * 255, bg.g * 255, bg.b * 255) - lum(ink.r * 255, ink.g * 255, ink.b * 255);
  if (contrast < 0.12) return { ink: black, bg };
  return { ink, bg };
}

export function rgbToCss({ r, g, b }: RGB): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

export function cssToRgb(css: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  const rgbMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]) / 255,
      g: Number(rgbMatch[2]) / 255,
      b: Number(rgbMatch[3]) / 255,
    };
  }
  return { r: 0.1, g: 0.1, b: 0.1 };
}
