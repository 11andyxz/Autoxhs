/**
 * 把「编辑计划」合成进 PDF。pdf-lib 是同构的,所以这一层浏览器和 Node 都能跑
 * ——UI 用它导出,单测用它做端到端断言(生成 PDF → 应用计划 → 再抽文字核对)。
 *
 * 坐标一律是 PDF 用户空间的点(pt,原点左下角),和 lib/pdfTools/pdfEdit.ts 对齐。
 */

import type { RGB, StandardFontKey } from "./pdfEdit";
import { needsUnicodeFont } from "./pdfEdit";

export interface RectItem {
  kind: "rect";
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: RGB;
  opacity?: number;
}

export interface TextItem {
  kind: "text";
  page: number;
  /** 左端 x */
  x: number;
  /** 首行基线 y */
  baseline: number;
  text: string;
  size: number;
  font: StandardFontKey;
  color: RGB;
  /** 多行时的行距(pt),默认 1.2 倍字号 */
  lineHeight?: number;
  /** 给了就把字号缩到这个宽度以内(只缩不放) */
  fitWidth?: number;
}

export interface ImageItem {
  kind: "image";
  page: number;
  /** 左下角 */
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
}

export type EditItem = RectItem | TextItem | ImageItem;

export interface PageSlotPlan {
  /** 源文档页序号(0 起) */
  src: number;
  /** 相对源页的旋转增量(度) */
  rotate: number;
  /**
   * 「扁平化」这一页:用这张位图整页重画,不复制源页内容。
   *
   * 为什么需要:遮盖矩形只是视觉遮挡,**原文字仍留在文件里**,导出后照样能被复制/搜索到
   * (改工资、改证件号这类场景就等于没改)。扁平化后整页变成图片,被遮的内容才真的没了。
   * 位图必须是「忽略 /Rotate 渲染」的(rotation: 0),这样它的坐标系和源页用户空间一致,
   * items 的坐标不用做任何换算;视觉朝向靠 setRotation 补回去。
   */
  flattenDataUrl?: string;
}

export interface EditPlan {
  /** 输出页顺序;省略表示原样保留全部页 */
  pages?: PageSlotPlan[];
  items: EditItem[];
}

export interface ApplyDeps {
  /** 需要写中文等非 WinAnsi 字符时,提供字体文件字节(bold 有独立字重就返回粗体) */
  loadUnicodeFont?: (bold: boolean) => Promise<Uint8Array>;
  /** fontkit 模块(v2 的 API 会被自动适配成 pdf-lib 期待的样子) */
  loadFontkit?: () => Promise<unknown>;
}

/** 计划里出现了必须嵌入 Unicode 字体的文本。 */
export function planNeedsUnicodeFont(plan: EditPlan): boolean {
  return plan.items.some((it) => it.kind === "text" && needsUnicodeFont(it.text));
}

interface FontkitSubsetV2 {
  encode(): Uint8Array;
  encodeStream?: unknown;
}

/**
 * fontkit v2 的 `subset.encode(): Uint8Array` 包成 pdf-lib 期待的 `subset.encodeStream()`。
 *
 * 为什么需要:pdf-lib 1.17 配的是老 @pdf-lib/fontkit,它给 CFF/OTF 生成的子集在
 * Apple PDFKit 里会画成乱码(实测中文变成 `!" !# $`);仓库里已有的 fontkit@2 子集是对的,
 * 但它把 `encodeStream()` 换成了 `encode()`,直接 registerFontkit 会报
 * `_this.subset.encodeStream is not a function`。这里补上这一层就能用上正确的子集。
 */
export function adaptFontkit(base: unknown): {
  create: (bytes: Uint8Array, postscriptName?: string) => unknown;
} {
  const mod = base as {
    default?: { create?: (b: Uint8Array, n?: string) => unknown };
    create?: (b: Uint8Array, n?: string) => unknown;
  };
  const create = mod.create ?? mod.default?.create;
  if (typeof create !== "function") throw new Error("fontkit 模块缺少 create()");
  return {
    create(bytes: Uint8Array, postscriptName?: string) {
      const font = create(bytes, postscriptName) as {
        createSubset?: () => FontkitSubsetV2;
      };
      const orig = font.createSubset?.bind(font);
      if (orig) {
        font.createSubset = () => {
          const subset = orig();
          if (typeof subset.encodeStream !== "function") {
            subset.encodeStream = () => {
              const handlers: Record<string, ((arg?: unknown) => void) | undefined> = {};
              let scheduled = false;
              const stream = {
                on(evt: string, cb: (arg?: unknown) => void) {
                  handlers[evt] = cb;
                  if (!scheduled) {
                    scheduled = true;
                    // 等 pdf-lib 把 data / end / error 三个回调都挂上再发
                    setTimeout(() => {
                      try {
                        handlers.data?.(subset.encode());
                        handlers.end?.();
                      } catch (err) {
                        handlers.error?.(err);
                      }
                    }, 0);
                  }
                  return stream;
                },
              };
              return stream;
            };
          }
          return subset;
        };
      }
      return font;
    },
  };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 先遮盖、再高亮、再图片、最后文字,免得后画的把改写后的字盖住。 */
const DRAW_ORDER: Record<EditItem["kind"], number> = { rect: 0, image: 1, text: 2 };

export class PdfEditError extends Error {}

/**
 * 应用编辑计划,返回新的 PDF 字节。
 * 只有在页面被删除/重排时才重建文档(copyPages);否则就地改,尽量少动原文件结构。
 */
export async function applyPdfEdits(
  src: ArrayBuffer | Uint8Array,
  plan: EditPlan,
  deps: ApplyDeps = {},
): Promise<Uint8Array> {
  const { PDFDocument, degrees, rgb } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(src as ArrayBuffer);
  const srcCount = srcDoc.getPageCount();
  const slots: PageSlotPlan[] =
    plan.pages && plan.pages.length > 0
      ? plan.pages.filter((p) => p.src >= 0 && p.src < srcCount)
      : Array.from({ length: srcCount }, (_, i) => ({ src: i, rotate: 0 }));
  if (slots.length === 0) throw new PdfEditError("至少要保留一页");

  const identity =
    slots.length === srcCount &&
    slots.every((s, i) => s.src === i && !s.flattenDataUrl);

  let doc: import("pdf-lib").PDFDocument;
  let pages: import("pdf-lib").PDFPage[];
  if (identity) {
    // 页序没动也不扁平化:就地改,原文件结构(表单域/书签/元数据)尽量不动
    doc = srcDoc;
    pages = srcDoc.getPages();
  } else {
    doc = await PDFDocument.create();
    const needCopy = slots.filter((s) => !s.flattenDataUrl).map((s) => s.src);
    const copied = needCopy.length > 0 ? await doc.copyPages(srcDoc, needCopy) : [];
    let copyCursor = 0;
    pages = [];
    for (const slot of slots) {
      if (slot.flattenDataUrl) {
        const { width, height } = srcDoc.getPage(slot.src).getSize();
        const page = doc.addPage([width, height]);
        const bytes = dataUrlToBytes(slot.flattenDataUrl);
        const img = /^data:image\/png/i.test(slot.flattenDataUrl)
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        page.drawImage(img, { x: 0, y: 0, width, height });
        // 位图是按未旋转渲染的,朝向靠 /Rotate 补回来
        page.setRotation(degrees(srcDoc.getPage(slot.src).getRotation().angle));
        pages.push(page);
      } else {
        pages.push(doc.addPage(copied[copyCursor++]));
      }
    }
  }

  // 旋转增量
  slots.forEach((slot, i) => {
    if (slot.rotate % 360 !== 0) {
      const cur = pages[i].getRotation().angle;
      pages[i].setRotation(degrees((((cur + slot.rotate) % 360) + 360) % 360));
    }
  });

  // 源页 → 输出页(同一源页被保留多次时都要画)
  const outputsOf = new Map<number, number[]>();
  slots.forEach((slot, i) => {
    const list = outputsOf.get(slot.src) ?? [];
    list.push(i);
    outputsOf.set(slot.src, list);
  });

  const stdFonts = new Map<string, import("pdf-lib").PDFFont>();
  const getStdFont = async (key: StandardFontKey) => {
    const hit = stdFonts.get(key);
    if (hit) return hit;
    // StandardFontKey 的取值就是 pdf-lib StandardFonts 枚举的字面量值
    const font = await doc.embedFont(key);
    stdFonts.set(key, font);
    return font;
  };

  const uniFonts = new Map<boolean, import("pdf-lib").PDFFont>();
  let fontkitRegistered = false;
  const getUnicodeFont = async (bold: boolean) => {
    const hit = uniFonts.get(bold);
    if (hit) return hit;
    if (!deps.loadUnicodeFont || !deps.loadFontkit) {
      throw new PdfEditError("这段文字含中文等特殊字符,需要嵌入字体,但没有提供字体加载器");
    }
    if (!fontkitRegistered) {
      const shim = adaptFontkit(await deps.loadFontkit());
      doc.registerFontkit(shim as unknown as Parameters<typeof doc.registerFontkit>[0]);
      fontkitRegistered = true;
    }
    const bytes = await deps.loadUnicodeFont(bold);
    const font = await doc.embedFont(bytes, { subset: true });
    uniFonts.set(bold, font);
    return font;
  };

  const sorted = [...plan.items].sort((a, b) => DRAW_ORDER[a.kind] - DRAW_ORDER[b.kind]);

  for (const item of sorted) {
    const targets = outputsOf.get(item.page) ?? [];
    for (const outIdx of targets) {
      const page = pages[outIdx];
      if (!page) continue;
      if (item.kind === "rect") {
        if (item.w <= 0 || item.h <= 0) continue;
        page.drawRectangle({
          x: item.x,
          y: item.y,
          width: item.w,
          height: item.h,
          color: rgb(item.color.r, item.color.g, item.color.b),
          opacity: item.opacity ?? 1,
          borderWidth: 0,
        });
      } else if (item.kind === "image") {
        const bytes = dataUrlToBytes(item.dataUrl);
        const img = /^data:image\/png/i.test(item.dataUrl)
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        page.drawImage(img, { x: item.x, y: item.y, width: item.w, height: item.h });
      } else {
        const text = item.text;
        if (!text.trim()) continue;
        const unicode = needsUnicodeFont(text);
        const font = unicode
          ? await getUnicodeFont(/Bold/i.test(item.font))
          : await getStdFont(item.font);
        let size = item.size;
        if (item.fitWidth && item.fitWidth > 0) {
          const lines = text.split("\n");
          const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
          if (widest > item.fitWidth) {
            size = Math.max((size * item.fitWidth) / widest, size * 0.55);
          }
        }
        const lineHeight = item.lineHeight ?? size * 1.2;
        const lines = text.split("\n");
        lines.forEach((line, i) => {
          if (!line) return;
          page.drawText(line, {
            x: item.x,
            y: item.baseline - i * lineHeight,
            size,
            font,
            color: rgb(item.color.r, item.color.g, item.color.b),
          });
        });
      }
    }
  }

  return doc.save();
}
