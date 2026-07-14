import { deflateSync } from "node:zlib";

import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** PDF 需要密码才能打开时抛出,由路由层映射成中文提示。 */
export class PdfEncryptedError extends Error {
  constructor(message = "PDF 已加密") {
    super(message);
    this.name = "PdfEncryptedError";
  }
}

// ---------- 纯逻辑部分(可单测):文本项 → 行 → 段落 ----------

export interface PositionedItem {
  str: string;
  /** PDF 用户空间坐标(pt),y 向上为正、取基线位置 */
  x: number;
  y: number;
  width: number;
  /** 近似字号(pt) */
  height: number;
  fontName?: string;
  fontFamily?: string;
}

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  fontSize: number;
}

export interface Line {
  y: number;
  x: number;
  right: number;
  fontSize: number;
  runs: Run[];
  text: string;
}

export interface PageStats {
  pageWidth: number;
  pageHeight: number;
  medianFontSize: number;
}

export type ParaAlignment = "left" | "center" | "right";

export interface ParaSpec {
  runs: Run[];
  alignment: ParaAlignment;
  /** 0 = 正文 */
  heading: 0 | 1 | 2;
  bullet: boolean;
  fontSize: number;
}

const BOLD_RE = /bold|black|heavy/i;
const ITALIC_RE = /italic|oblique/i;
const BULLET_RE = /^[●•·▪–-]\s+/;
const BULLET_MARKER_ONLY_RE = /^[●•·▪–-]$/;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dominantSize(pairs: Array<{ size: number; weight: number }>): number {
  const tally = new Map<number, number>();
  for (const p of pairs) tally.set(p.size, (tally.get(p.size) ?? 0) + p.weight);
  let best = 12;
  let bestWeight = -1;
  for (const [size, weight] of tally) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best;
}

function itemStyle(it: PositionedItem): { bold: boolean; italic: boolean } {
  const name = `${it.fontName ?? ""} ${it.fontFamily ?? ""}`;
  return { bold: BOLD_RE.test(name), italic: ITALIC_RE.test(name) };
}

function buildLine(members: PositionedItem[]): Line {
  const sorted = [...members].sort((a, b) => a.x - b.x);
  const runs: Run[] = [];
  let prevEnd = Number.NaN;
  for (const it of sorted) {
    const { bold, italic } = itemStyle(it);
    const fontSize = Math.round(it.height) || 12;
    const gap = Number.isNaN(prevEnd) ? 0 : it.x - prevEnd;
    const last = runs[runs.length - 1];
    // 相邻项之间水平留白超过 ~0.25em 时视为原文的空格
    const needSpace =
      last !== undefined &&
      gap > 0.25 * (it.height || fontSize) &&
      !last.text.endsWith(" ") &&
      !it.str.startsWith(" ");
    if (last && last.bold === bold && last.italic === italic && last.fontSize === fontSize) {
      last.text += (needSpace ? " " : "") + it.str;
    } else {
      if (needSpace && last) last.text += " ";
      runs.push({ text: it.str, bold, italic, fontSize });
    }
    prevEnd = it.x + it.width;
  }
  const x = Math.min(...sorted.map((m) => m.x));
  const right = Math.max(...sorted.map((m) => m.x + m.width));
  const y = sorted.reduce((s, m) => s + m.y, 0) / sorted.length;
  const fontSize = dominantSize(
    sorted.map((m) => ({ size: Math.round(m.height) || 12, weight: Math.max(m.str.length, 1) })),
  );
  return { y, x, right, fontSize, runs, text: runs.map((r) => r.text).join("") };
}

/** 把散落的文本项聚成行:y 相近的归同一行,行按自上而下排序,行内按 x 排序。 */
export function groupIntoLines(items: PositionedItem[]): Line[] {
  const usable = items.filter((it) => it.str.trim().length > 0);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PositionedItem[][] = [];
  for (const it of sorted) {
    const cur = groups[groups.length - 1];
    if (cur) {
      const refY = cur.reduce((s, m) => s + m.y, 0) / cur.length;
      const tol = Math.max(2, 0.4 * Math.max(it.height, cur[0].height));
      if (Math.abs(it.y - refY) < tol) {
        cur.push(it);
        continue;
      }
    }
    groups.push([it]);
  }
  return groups.map(buildLine);
}

function stripBulletMarker(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  const first = out[0];
  if (!first) return out;
  if (BULLET_MARKER_ONLY_RE.test(first.text.trim())) {
    out.shift();
    if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
  } else {
    first.text = first.text.replace(/^\s*/, "").replace(BULLET_RE, "");
  }
  return out;
}

/** 段内换行还原为连续文本(补一个空格),并合并样式相同的相邻 run。 */
function mergeParaRuns(paraLines: Line[], bullet: boolean): Run[] {
  const runs: Run[] = [];
  for (const line of paraLines) {
    const lineRuns = line.runs.map((r) => ({ ...r }));
    const last = runs[runs.length - 1];
    if (last && !last.text.endsWith(" ") && !lineRuns[0]?.text.startsWith(" ")) {
      last.text += " ";
    }
    for (const r of lineRuns) {
      const tail = runs[runs.length - 1];
      if (tail && tail.bold === r.bold && tail.italic === r.italic && tail.fontSize === r.fontSize) {
        tail.text += r.text;
      } else {
        runs.push(r);
      }
    }
  }
  return bullet ? stripBulletMarker(runs) : runs;
}

/** 把行合并成段落,并标注对齐、列表、标题层级。lines 需已按自上而下排序。 */
export function linesToParagraphs(lines: Line[], stats: PageStats): ParaSpec[] {
  if (lines.length === 0) return [];
  const pageWidth = stats.pageWidth || 612;
  const contentRight = Math.max(...lines.map((l) => l.right));
  const contentLeft = Math.min(...lines.map((l) => l.x));
  // 判断"行没占满"要按实际内容宽度:按页宽算的话,常规页边距会让整页正文都被误判为居中
  const contentWidth = Math.max(contentRight - contentLeft, 0.75 * pageWidth);

  const alignOf = (line: Line): ParaAlignment => {
    const width = line.right - line.x;
    const center = (line.x + line.right) / 2;
    if (Math.abs(center - pageWidth / 2) < 0.08 * pageWidth && width < 0.85 * contentWidth) {
      return "center";
    }
    if (line.right >= contentRight - 0.05 * pageWidth && line.x > 0.55 * pageWidth) {
      return "right";
    }
    return "left";
  };

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const medGap = median(gaps) || stats.medianFontSize * 1.2 || 14;

  interface Accum {
    lines: Line[];
    alignment: ParaAlignment;
    bullet: boolean;
  }
  const accums: Accum[] = [];
  let cur: Accum | null = null;

  for (const line of lines) {
    const alignment = alignOf(line);
    const isBullet = BULLET_RE.test(line.text.trimStart());
    let split = cur === null || isBullet;
    if (cur && !split) {
      const prev = cur.lines[cur.lines.length - 1];
      const gap = Math.abs(prev.y - line.y);
      if (gap > 1.6 * medGap) split = true;
      else if (!cur.bullet && alignment !== cur.alignment) split = true;
      else if (Math.abs(line.fontSize - prev.fontSize) > 0.15 * Math.max(prev.fontSize, 1)) {
        split = true;
      }
    }
    if (split || !cur) {
      cur = { lines: [line], alignment, bullet: isBullet };
      accums.push(cur);
    } else {
      cur.lines.push(line);
    }
  }

  const results = accums
    .map((acc) => {
      const runs = mergeParaRuns(acc.lines, acc.bullet);
      const fontSize = dominantSize(
        runs.map((r) => ({ size: r.fontSize, weight: Math.max(r.text.length, 1) })),
      );
      const text = runs.map((r) => r.text).join("");
      const allCaps = /[A-Z]/.test(text) && !/[a-z]/.test(text);
      let candidate =
        !acc.bullet && stats.medianFontSize > 0 && fontSize >= 1.25 * stats.medianFontSize;
      // 单行全大写的居中段按"居中加粗、保持字号"处理,不转成 Word 标题样式
      if (candidate && acc.lines.length === 1 && allCaps && acc.alignment === "center") {
        candidate = false;
        for (const r of runs) r.bold = true;
      }
      const spec: ParaSpec = {
        runs,
        alignment: acc.alignment,
        heading: 0,
        bullet: acc.bullet,
        fontSize,
      };
      return { spec, candidate };
    })
    .filter((r) => r.spec.runs.some((run) => run.text.trim() !== ""));

  const headingSizes = [...new Set(results.filter((r) => r.candidate).map((r) => r.spec.fontSize))]
    .sort((a, b) => b - a);
  for (const r of results) {
    if (r.candidate) r.spec.heading = r.spec.fontSize === headingSizes[0] ? 1 : 2;
  }
  return results.map((r) => r.spec);
}

// ---------- 最小 PNG 编码(RGBA,filter 0) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write(type, 4, "ascii");
  chunk.set(body, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  return chunk;
}

/** 把 RGBA 像素编码为 PNG(色彩类型 6,每行 filter 0)。 */
export function pngFromRaw(width: number, height: number, rgba: Uint8Array): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    rgba.length < width * height * 4
  ) {
    throw new Error("pngFromRaw: 尺寸与数据不匹配");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------- pdf.js 交互与 docx 组装 ----------

// pdf.js 的 d.mts 类型在 strict 下不稳,这里只声明用到的最小结构
interface PdfjsLike {
  getDocument(params: {
    data: Uint8Array;
    useSystemFonts: boolean;
    isEvalSupported: boolean;
  }): { promise: Promise<PdfDocLike>; destroy(): Promise<void> };
  OPS: Record<string, number>;
}

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

interface ObjPoolLike {
  has(id: string): boolean;
  get(id: string): unknown;
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{
    items: unknown[];
    styles: Record<string, { fontFamily?: string } | undefined>;
  }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  objs: ObjPoolLike;
  commonObjs: ObjPoolLike;
}

interface RawImageLike {
  width?: number;
  height?: number;
  kind?: number;
  data?: unknown;
}

interface PageImage {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  drawnW?: number;
  drawnH?: number;
}

const MAX_IMAGES_PER_PAGE = 30;
const MAX_IMG_WIDTH_PX = 624; // 6.5in @ 96dpi

function matMul(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function rawImageToPng(img: RawImageLike): { png: Buffer; width: number; height: number } | null {
  const width = img.width ?? 0;
  const height = img.height ?? 0;
  const kind = img.kind ?? 0;
  const data = img.data;
  if (width < 4 || height < 4) return null;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) return null;
  const px = width * height;
  const rgba = new Uint8Array(px * 4);
  if (kind === 3) {
    // RGBA_32BPP
    if (data.length < px * 4) return null;
    rgba.set(data.subarray(0, px * 4));
  } else if (kind === 2) {
    // RGB_24BPP
    if (data.length < px * 3) return null;
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      rgba[i * 4] = data[j];
      rgba[i * 4 + 1] = data[j + 1];
      rgba[i * 4 + 2] = data[j + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (kind === 1) {
    // GRAYSCALE_1BPP:行按字节对齐,置位 = 白
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return { png: pngFromRaw(width, height, rgba), width, height };
}

function resolveImageObj(page: PdfPageLike, name: string): RawImageLike | null {
  for (const pool of [page.objs, page.commonObjs]) {
    try {
      if (pool.has(name)) {
        const obj = pool.get(name);
        if (obj && typeof obj === "object") return obj as RawImageLike;
      }
    } catch {
      // 对象未就绪等情况,继续尝试下一个池
    }
  }
  return null;
}

async function extractPageImages(
  pdfjs: PdfjsLike,
  page: PdfPageLike,
  pageArea: number,
): Promise<PageImage[]> {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;
  const results: PageImage[] = [];
  // 模拟变换栈,估算图片实际绘制尺寸(用于过滤铺满页面的水印/背景图)
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  for (let i = 0; i < ops.fnArray.length && results.length < MAX_IMAGES_PER_PAGE; i++) {
    const fn = ops.fnArray[i];
    const args = Array.isArray(ops.argsArray[i]) ? (ops.argsArray[i] as unknown[]) : [];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      const m = args as number[];
      if (m.length >= 6) ctm = matMul(ctm, m);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      try {
        const raw =
          fn === OPS.paintInlineImageXObject
            ? (args[0] as RawImageLike | undefined)
            : typeof args[0] === "string"
              ? resolveImageObj(page, args[0])
              : null;
        if (!raw) continue;
        const converted = rawImageToPng(raw);
        if (!converted) continue;
        const drawnW = Math.hypot(ctm[0], ctm[1]);
        const drawnH = Math.hypot(ctm[2], ctm[3]);
        // 绘制面积超过 ~80% 页面的按水印/背景处理,跳过
        if (drawnW > 0 && drawnH > 0 && drawnW * drawnH > 0.8 * pageArea) continue;
        results.push({
          png: converted.png,
          widthPx: converted.width,
          heightPx: converted.height,
          drawnW: drawnW > 1 ? drawnW : undefined,
          drawnH: drawnH > 1 ? drawnH : undefined,
        });
      } catch {
        // 单张图片失败不影响其余内容
      }
    }
  }
  return results;
}

function imageParagraph(img: PageImage, pageBreakBefore: boolean): Paragraph {
  // 优先按页面上的实际绘制尺寸(pt → px);拿不到就用图片固有像素
  let w = img.drawnW !== undefined ? (img.drawnW * 96) / 72 : img.widthPx;
  let h =
    img.drawnW !== undefined && img.drawnH !== undefined
      ? (img.drawnH * 96) / 72
      : img.heightPx;
  if (w > MAX_IMG_WIDTH_PX) {
    h = (h * MAX_IMG_WIDTH_PX) / w;
    w = MAX_IMG_WIDTH_PX;
  }
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    pageBreakBefore,
    children: [
      new ImageRun({
        type: "png",
        data: img.png,
        transformation: {
          width: Math.max(1, Math.round(w)),
          height: Math.max(1, Math.round(h)),
        },
      }),
    ],
  });
}

function paraToDocx(spec: ParaSpec, pageBreakBefore: boolean): Paragraph {
  return new Paragraph({
    pageBreakBefore,
    alignment:
      spec.alignment === "center"
        ? AlignmentType.CENTER
        : spec.alignment === "right"
          ? AlignmentType.RIGHT
          : undefined,
    heading:
      spec.heading === 1
        ? HeadingLevel.HEADING_1
        : spec.heading === 2
          ? HeadingLevel.HEADING_2
          : undefined,
    bullet: spec.bullet ? { level: 0 } : undefined,
    children: spec.runs.map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold || undefined,
          italics: r.italic || undefined,
          size: Math.max(2, Math.round(r.fontSize * 2)),
        }),
    ),
  });
}

/** 解析 PDF 并尽量还原结构(行/段落/标题/列表/图片),生成 .docx。 */
export async function pdfToDocx(buf: Buffer): Promise<Buffer> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
  // 复制一份:pdf.js 会转移(detach)传入的缓冲区
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  let doc: PdfDocLike;
  try {
    doc = await task.promise;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "PasswordException" || /password/i.test(String(e?.message ?? ""))) {
      throw new PdfEncryptedError();
    }
    throw err;
  }

  try {
    const children: Paragraph[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();

      const items: PositionedItem[] = [];
      for (const rawItem of tc.items) {
        const it = rawItem as {
          str?: unknown;
          transform?: unknown;
          width?: unknown;
          height?: unknown;
          fontName?: unknown;
        };
        if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
        const t = it.transform as number[];
        const height =
          (typeof it.height === "number" && it.height > 0 ? it.height : 0) ||
          Math.hypot(t[2] ?? 0, t[3] ?? 0) ||
          12;
        const fontName = typeof it.fontName === "string" ? it.fontName : undefined;
        items.push({
          str: it.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          width: typeof it.width === "number" ? it.width : 0,
          height,
          fontName,
          fontFamily: fontName ? tc.styles[fontName]?.fontFamily : undefined,
        });
      }

      const lines = groupIntoLines(items);
      const stats: PageStats = {
        pageWidth: viewport.width,
        pageHeight: viewport.height,
        medianFontSize: median(lines.map((l) => l.fontSize)) || 12,
      };
      const paras = linesToParagraphs(lines, stats);

      let images: PageImage[] = [];
      try {
        images = await extractPageImages(pdfjs, page, viewport.width * viewport.height);
      } catch {
        // 整页图片提取失败时仅保留文本
      }

      // 位置追踪不可靠,图片统一放在该页内容开头(阅读序、居中)
      let needBreak = p > 1;
      for (const img of images) {
        children.push(imageParagraph(img, needBreak));
        needBreak = false;
      }
      for (const spec of paras) {
        children.push(paraToDocx(spec, needBreak));
        needBreak = false;
      }
      if (needBreak || children.length === 0) {
        children.push(new Paragraph({ pageBreakBefore: p > 1, children: [] }));
      }
    }

    const out = new Document({
      sections: [
        {
          properties: { page: { size: { width: "8.5in", height: "11in" } } },
          children,
        },
      ],
    });
    return await Packer.toBuffer(out);
  } finally {
    // v6 的资源清理入口在 loading task 上
    await Promise.resolve(task.destroy()).catch(() => {});
  }
}
