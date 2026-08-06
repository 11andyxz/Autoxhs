/**
 * 端到端:pdf-lib 造一份 PDF → 应用编辑计划 → 用 pdfjs 把结果读回来核对。
 * 只 grep 源码证明「两头都写了」是不够的,中间那道缝(坐标、字体、页序)必须真跑一遍。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pngFromRaw } from "./pdfToWord";
import { adaptFontkit, applyPdfEdits, type EditPlan } from "./pdfEditApply";

const FONT_DIR = join(process.cwd(), "lib", "job-hunter", "assets", "fonts");

const CJK_DEPS = {
  loadUnicodeFont: async (bold: boolean) =>
    new Uint8Array(readFileSync(join(FONT_DIR, bold ? "NotoSansSC-Bold.otf" : "NotoSansSC-Regular.otf"))),
  loadFontkit: async () => await import("fontkit"),
};

/** 两页:第 1 页 "Andy Zheng" + "Salary 120000",第 2 页 "Page Two"。 */
async function makePdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Andy Zheng", { x: 72, y: 700, size: 12, font: helv });
  p1.drawText("Salary 120000", { x: 72, y: 660, size: 12, font: helv });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("Page Two", { x: 72, y: 700, size: 12, font: helv });
  return doc.save();
}

interface ExtractedItem {
  str: string;
  x: number;
  y: number;
  size: number;
}

interface ExtractedPage {
  text: string;
  items: ExtractedItem[];
  width: number;
  height: number;
  rotate: number;
}

async function extract(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(p: object): { promise: Promise<unknown>; destroy(): Promise<void> };
  };
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = (await task.promise) as {
    numPages: number;
    getPage(n: number): Promise<{
      rotate: number;
      getViewport(o: { scale: number }): { width: number; height: number };
      getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
    }>;
  };
  try {
    const out: ExtractedPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: ExtractedItem[] = [];
      for (const raw of tc.items) {
        const str = raw.str as string | undefined;
        const t = raw.transform as number[] | undefined;
        if (typeof str !== "string" || !str.trim() || !t) continue;
        items.push({ str, x: t[4], y: t[5], size: Math.hypot(t[2], t[3]) });
      }
      out.push({
        text: items.map((it) => it.str).join(" "),
        items,
        width: vp.width,
        height: vp.height,
        rotate: page.rotate,
      });
    }
    return out;
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** 一张纯白位图的 dataURL(扁平化测试用,内容无所谓,只验证「原文字层被替换掉」)。 */
function whitePng(w = 4, h = 4): string {
  const rgba = new Uint8Array(w * h * 4).fill(255);
  return `data:image/png;base64,${pngFromRaw(w, h, rgba).toString("base64")}`;
}

describe("applyPdfEdits · 改字", () => {
  it("在原位置画上新文字,页数与页面尺寸不变", async () => {
    const src = await makePdf();
    const plan: EditPlan = {
      items: [
        { kind: "rect", page: 0, x: 71, y: 697, w: 60, h: 12, color: { r: 1, g: 1, b: 1 } },
        {
          kind: "text",
          page: 0,
          x: 72,
          baseline: 700,
          text: "Zheng Xiong",
          size: 12,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
        },
      ],
    };
    const out = await applyPdfEdits(src, plan);
    const pages = await extract(out);

    expect(pages).toHaveLength(2);
    expect(pages[0].width).toBe(612);
    expect(pages[0].height).toBe(792);
    expect(pages[0].text).toContain("Zheng Xiong");

    const drawn = pages[0].items.find((it) => it.str.includes("Zheng Xiong"));
    expect(drawn).toBeDefined();
    expect(drawn!.x).toBeCloseTo(72, 1);
    expect(drawn!.y).toBeCloseTo(700, 1);
    expect(drawn!.size).toBeCloseTo(12, 1);
  });

  it("遮盖矩形只是视觉遮挡:原文字仍留在文字层(所以才要扁平化)", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      items: [{ kind: "rect", page: 0, x: 71, y: 655, w: 100, h: 14, color: { r: 1, g: 1, b: 1 } }],
    });
    const pages = await extract(out);
    expect(pages[0].text).toContain("Salary 120000");
  });

  it("扁平化后被遮盖的原文字真的没了,新文字还在", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      pages: [
        { src: 0, rotate: 0, flattenDataUrl: whitePng() },
        { src: 1, rotate: 0 },
      ],
      items: [
        { kind: "rect", page: 0, x: 71, y: 655, w: 100, h: 14, color: { r: 1, g: 1, b: 1 } },
        {
          kind: "text",
          page: 0,
          x: 72,
          baseline: 660,
          text: "Salary 130000",
          size: 12,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
        },
      ],
    });
    const pages = await extract(out);
    expect(pages).toHaveLength(2);
    expect(pages[0].text).not.toContain("120000");
    expect(pages[0].text).not.toContain("Andy Zheng");
    expect(pages[0].text).toContain("Salary 130000");
    // 扁平化的页尺寸要和源页一致
    expect(pages[0].width).toBe(612);
    expect(pages[0].height).toBe(792);
    // 没扁平化的页原样保留
    expect(pages[1].text).toContain("Page Two");
  });

  it("fitWidth 会把过长的文字缩到原来的宽度以内", async () => {
    const src = await makePdf();
    const long = "This replacement text is far too long for the slot";
    const out = await applyPdfEdits(src, {
      items: [
        {
          kind: "text",
          page: 0,
          x: 72,
          baseline: 700,
          text: long,
          size: 12,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
          fitWidth: 60,
        },
      ],
    });
    const pages = await extract(out);
    const drawn = pages[0].items.find((it) => it.str.includes("replacement"));
    expect(drawn).toBeDefined();
    // 12pt 缩到 55% 下限 = 6.6pt
    expect(drawn!.size).toBeLessThan(12);
    expect(drawn!.size).toBeGreaterThanOrEqual(6.5);
  });

  it("多行文本按行距往下排", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      items: [
        {
          kind: "text",
          page: 0,
          x: 100,
          baseline: 500,
          text: "line one\nline two",
          size: 10,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
          lineHeight: 14,
        },
      ],
    });
    const pages = await extract(out);
    const one = pages[0].items.find((it) => it.str.includes("line one"));
    const two = pages[0].items.find((it) => it.str.includes("line two"));
    expect(one!.y).toBeCloseTo(500, 1);
    expect(two!.y).toBeCloseTo(486, 1);
  });
});

describe("applyPdfEdits · 页面操作", () => {
  it("按 plan.pages 重排并删页", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, { pages: [{ src: 1, rotate: 0 }], items: [] });
    const pages = await extract(out);
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("Page Two");
  });

  it("交换页序后,items 仍然跟着它自己的源页走", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      pages: [
        { src: 1, rotate: 0 },
        { src: 0, rotate: 0 },
      ],
      items: [
        {
          kind: "text",
          page: 0,
          x: 300,
          baseline: 400,
          text: "MARK-SRC0",
          size: 10,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
        },
      ],
    });
    const pages = await extract(out);
    expect(pages[0].text).toContain("Page Two");
    expect(pages[0].text).not.toContain("MARK-SRC0");
    expect(pages[1].text).toContain("Andy Zheng");
    expect(pages[1].text).toContain("MARK-SRC0");
  });

  it("同一源页保留两次时,两页都会画上 items", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      pages: [
        { src: 0, rotate: 0 },
        { src: 0, rotate: 90 },
      ],
      items: [
        {
          kind: "text",
          page: 0,
          x: 300,
          baseline: 400,
          text: "TWICE",
          size: 10,
          font: "Helvetica",
          color: { r: 0, g: 0, b: 0 },
        },
      ],
    });
    const pages = await extract(out);
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain("TWICE");
    expect(pages[1].text).toContain("TWICE");
    expect(pages[1].rotate).toBe(90);
  });

  it("旋转是相对源页的增量,并且规范化到 0~359", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(src, {
      pages: [
        { src: 0, rotate: 270 },
        { src: 1, rotate: -90 },
      ],
      items: [],
    });
    const pages = await extract(out);
    expect(pages[0].rotate).toBe(270);
    expect(pages[1].rotate).toBe(270);
  });

  it("空页列表直接报错,不产出一个 0 页的坏 PDF", async () => {
    const src = await makePdf();
    await expect(applyPdfEdits(src, { pages: [{ src: 99, rotate: 0 }], items: [] })).rejects.toThrow(
      /至少要保留一页/,
    );
  });
});

describe("applyPdfEdits · 中文", () => {
  it("嵌入 Noto Sans SC 子集,写进去的中文能原样读回来", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(
      src,
      {
        items: [
          {
            kind: "text",
            page: 0,
            x: 72,
            baseline: 600,
            text: "郑安迪 中文测试 mixed 123",
            size: 14,
            font: "Helvetica",
            color: { r: 0, g: 0, b: 0 },
          },
        ],
      },
      CJK_DEPS,
    );
    const pages = await extract(out);
    expect(pages[0].text).toContain("郑安迪 中文测试 mixed 123");
    // 子集嵌入:整份文件不该被 8MB 的字体撑爆
    expect(out.byteLength).toBeLessThan(1_500_000);
  });

  it("粗体中文走 Bold 字重", async () => {
    const src = await makePdf();
    const out = await applyPdfEdits(
      src,
      {
        items: [
          {
            kind: "text",
            page: 0,
            x: 72,
            baseline: 560,
            text: "粗体中文",
            size: 14,
            font: "Helvetica-Bold",
            color: { r: 0, g: 0, b: 0 },
          },
        ],
      },
      CJK_DEPS,
    );
    expect((await extract(out))[0].text).toContain("粗体中文");
  });

  it("没有字体加载器时给出能看懂的错误", async () => {
    const src = await makePdf();
    await expect(
      applyPdfEdits(src, {
        items: [
          {
            kind: "text",
            page: 0,
            x: 72,
            baseline: 600,
            text: "中文",
            size: 12,
            font: "Helvetica",
            color: { r: 0, g: 0, b: 0 },
          },
        ],
      }),
    ).rejects.toThrow(/需要嵌入字体/);
  });
});

/** pdf-lib 那边是 `.on("data").on("end").on("error")` 链式调用的 */
interface ChainableStream {
  on(event: string, cb: (arg?: unknown) => void): ChainableStream;
}

describe("adaptFontkit", () => {
  it("给 fontkit v2 的 subset 补上 pdf-lib 要的 encodeStream()", async () => {
    const shim = adaptFontkit(await import("fontkit"));
    const font = shim.create(
      new Uint8Array(readFileSync(join(FONT_DIR, "NotoSansSC-Regular.otf"))),
    ) as {
      createSubset(): { encodeStream(): ChainableStream };
      glyphsForString(s: string): unknown[];
    };
    const subset = font.createSubset();
    for (const g of font.glyphsForString("郑安迪")) {
      (subset as unknown as { includeGlyph(g: unknown): void }).includeGlyph(g);
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const parts: Uint8Array[] = [];
      subset
        .encodeStream()
        .on("data", (b) => parts.push(b as Uint8Array))
        .on("end", () => resolve(parts[0] ?? new Uint8Array()))
        .on("error", (e) => reject(e));
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // Noto Sans SC 是 CFF 轮廓,子集出来的是裸 CFF 字体程序(头部 major=1、minor=0),
    // 正是 PDF 里 FontFile3/Type1C 需要的形态;TrueType 轮廓的字体则是 sfnt 魔数。
    const tag = String.fromCharCode(...bytes.subarray(0, 4));
    const isCff = bytes[0] === 1 && bytes[1] === 0;
    const isSfnt = ["OTTO", "true"].includes(tag) || (bytes[0] === 0 && bytes[1] === 1);
    expect(isCff || isSfnt).toBe(true);
  });

  it("拿到不认识的模块时报错而不是静默失败", () => {
    expect(() => adaptFontkit({})).toThrow(/fontkit/);
  });
});
