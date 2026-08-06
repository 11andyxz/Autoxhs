import { describe, expect, it } from "vitest";

import {
  applyInvMat,
  applyMat,
  blockBox,
  cssToRgb,
  deletePageSlot,
  estimateWidthPt,
  familyFromMeta,
  fitTextSize,
  fontKeyFor,
  groupIntoBlocks,
  invertMat,
  movePageSlot,
  needsUnicodeFont,
  rotatePageSlot,
  sampleColors,
  screenToLocalFraction,
  type FontMeta,
  type Mat,
  type PageSlot,
  type RawTextItem,
  type TextBlock,
} from "./pdfEdit";

function item(str: string, x: number, y: number, width: number, extra: Partial<RawTextItem> = {}): RawTextItem {
  return { str, x, y, width, height: 12, fontName: "f1", ...extra };
}

const FONTS = new Map<string, FontMeta>([
  ["f1", { name: "Helvetica", bold: false, italic: false, ascent: 0.718, descent: -0.207 }],
  ["fB", { name: "Helvetica-Bold", bold: true, italic: false, ascent: 0.718, descent: -0.207 }],
  ["fS", { name: "Times-Roman", bold: false, italic: false, ascent: 0.683, descent: -0.217 }],
]);

describe("groupIntoBlocks", () => {
  it("keeps one visual run together and preserves its box", () => {
    const blocks = groupIntoBlocks([item("Employee Name", 72, 700, 92.7)], FONTS, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: "Employee Name", x: 72, baseline: 700, size: 12, page: 0 });
    expect(blocks[0].width).toBeCloseTo(92.7, 5);
  });

  it("splits a line at a wide horizontal gap (form label vs. value)", () => {
    // 72..164.7 是标签,220 起是填的值 —— 中间空了 55pt(>1.1em),必须各成一块
    const blocks = groupIntoBlocks(
      [item("Employee Name", 72, 700, 92.7, { fontName: "fB" }), item("Andy Zheng", 220, 700, 64.7)],
      FONTS,
      0,
    );
    expect(blocks.map((b) => b.text)).toEqual(["Employee Name", "Andy Zheng"]);
    expect(blocks[0].bold).toBe(true);
    expect(blocks[1].bold).toBe(false);
  });

  it("joins near-adjacent runs and inserts a space for a small gap", () => {
    const blocks = groupIntoBlocks([item("Total:", 72, 700, 30), item("5000", 106, 700, 24)], FONTS, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Total: 5000");
    expect(blocks[0].width).toBeCloseTo(58, 5);
  });

  it("does not insert a space when runs are flush", () => {
    const blocks = groupIntoBlocks([item("Auto", 72, 700, 24), item("xhs", 96.5, 700, 18)], FONTS, 0);
    expect(blocks[0].text).toBe("Autoxhs");
  });

  it("splits when the style changes even with no gap", () => {
    const blocks = groupIntoBlocks(
      [item("Total: ", 72, 700, 30, { fontName: "fB" }), item("5000", 102, 700, 24)],
      FONTS,
      0,
    );
    expect(blocks.map((b) => b.text)).toEqual(["Total: ", "5000"]);
  });

  it("orders blocks top-down and ignores pdfjs gap fillers / empty items", () => {
    const blocks = groupIntoBlocks(
      [
        item("second line", 72, 660, 60),
        item(" ", 164, 700, 55, { height: 0 }),
        item("", 72, 700, 0, { height: 0 }),
        item("first line", 72, 700, 50),
      ],
      FONTS,
      0,
    );
    expect(blocks.map((b) => b.text)).toEqual(["first line", "second line"]);
  });

  it("gives every block a stable, page-scoped id", () => {
    const blocks = groupIntoBlocks([item("a", 72, 700, 10), item("b", 72, 660, 10)], FONTS, 3);
    expect(blocks.map((b) => b.id)).toEqual(["p3b0", "p3b1"]);
  });

  it("averages near-equal font sizes weighted by text length", () => {
    const blocks = groupIntoBlocks(
      [item("aaaaaaaaaa", 72, 700, 50, { height: 10 }), item("b", 122.5, 700, 6, { height: 11 })],
      FONTS,
      0,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].size).toBeCloseTo((10 * 10 + 11) / 11, 2);
  });

  it("splits when the font size jumps (heading vs. body on one line)", () => {
    const blocks = groupIntoBlocks(
      [item("BIG", 72, 700, 40, { height: 20 }), item("small", 113, 700, 20, { height: 10 })],
      FONTS,
      0,
    );
    expect(blocks.map((b) => b.text)).toEqual(["BIG", "small"]);
  });
});

describe("blockBox", () => {
  const block: TextBlock = {
    id: "b",
    page: 0,
    text: "x",
    x: 100,
    baseline: 500,
    width: 40,
    size: 10,
    bold: false,
    italic: false,
    family: "sans",
    ascent: 0.75,
    descent: -0.25,
  };

  it("spans ascent..descent around the baseline with padding", () => {
    const box = blockBox(block, 1);
    expect(box.x).toBe(99);
    expect(box.y).toBeCloseTo(500 - 2.5 - 1, 5);
    expect(box.w).toBeCloseTo(42, 5);
    expect(box.h).toBeCloseTo(10 + 2, 5);
  });

  it("falls back to sane metrics when the font reports none", () => {
    const box = blockBox({ ...block, ascent: 0, descent: 0 }, 0);
    expect(box.h).toBeGreaterThan(0);
    expect(box.y).toBeLessThan(block.baseline);
  });
});

describe("matrices", () => {
  // pdfjs 视口矩阵(scale=1、无旋转):y 翻转
  const flip: Mat = [1, 0, 0, -1, 0, 792];

  it("maps pdf points into viewport space", () => {
    expect(applyMat(flip, 72, 700)).toEqual([72, 92]);
  });

  it("round-trips through the inverse", () => {
    const rot90: Mat = [0, 1, 1, 0, 0, 0];
    for (const m of [flip, rot90, [2, 0, 0, -2, 10, 100] as Mat]) {
      const [vx, vy] = applyMat(m, 123.5, 456.25);
      const [px, py] = applyInvMat(m, vx, vy);
      expect(px).toBeCloseTo(123.5, 6);
      expect(py).toBeCloseTo(456.25, 6);
    }
  });

  it("throws on a degenerate matrix instead of silently producing NaN", () => {
    expect(() => invertMat([0, 0, 0, 0, 0, 0])).toThrow();
  });
});

describe("screenToLocalFraction", () => {
  // 未旋转时 200x100 的元素,左上角在 (10, 20)
  it("maps a click with no rotation", () => {
    const r = screenToLocalFraction({ left: 10, top: 20, width: 200, height: 100 }, 0, 60, 45);
    expect(r.fx).toBeCloseTo(0.25, 6);
    expect(r.fy).toBeCloseTo(0.25, 6);
  });

  it("maps a click when the page is rotated 90°", () => {
    // 旋转 90° 后外接矩形变成 100x200;元素左上角(内部 0,0)转到了屏幕右上角
    const box = { left: 10, top: 20, width: 100, height: 200 };
    const r = screenToLocalFraction(box, 90, 10 + 100 - 25, 20 + 50);
    expect(r.fx).toBeCloseTo(0.25, 6);
    expect(r.fy).toBeCloseTo(0.25, 6);
  });

  it("maps a click when the page is rotated 180° / 270°", () => {
    const r180 = screenToLocalFraction({ left: 0, top: 0, width: 200, height: 100 }, 180, 150, 75);
    expect(r180.fx).toBeCloseTo(0.25, 6);
    expect(r180.fy).toBeCloseTo(0.25, 6);

    const r270 = screenToLocalFraction({ left: 0, top: 0, width: 100, height: 200 }, 270, 25, 150);
    expect(r270.fx).toBeCloseTo(0.25, 6);
    expect(r270.fy).toBeCloseTo(0.25, 6);
  });

  it("normalizes negative and >360 angles", () => {
    const a = screenToLocalFraction({ left: 0, top: 0, width: 100, height: 200 }, -90, 25, 150);
    const b = screenToLocalFraction({ left: 0, top: 0, width: 100, height: 200 }, 270, 25, 150);
    expect(a).toEqual(b);
  });
});

describe("font selection", () => {
  it("maps families and styles onto the 12 built-in fonts", () => {
    expect(fontKeyFor("sans", false, false)).toBe("Helvetica");
    expect(fontKeyFor("sans", true, true)).toBe("Helvetica-BoldOblique");
    expect(fontKeyFor("serif", true, false)).toBe("Times-Bold");
    expect(fontKeyFor("serif", false, true)).toBe("Times-Italic");
    expect(fontKeyFor("mono", true, true)).toBe("Courier-BoldOblique");
  });

  it("classifies real BaseFont names", () => {
    expect(familyFromMeta({ name: "Times-Roman" })).toBe("serif");
    expect(familyFromMeta({ name: "ABCDEE+Calibri" })).toBe("sans");
    expect(familyFromMeta({ name: "CourierNewPSMT" })).toBe("mono");
    expect(familyFromMeta({ name: "ABCDEE+Georgia,Bold" })).toBe("serif");
  });

  it("falls back to pdfjs' generic family when there is no real name", () => {
    expect(familyFromMeta({ fallback: "serif" })).toBe("serif");
    expect(familyFromMeta({ fallback: "sans-serif" })).toBe("sans");
    expect(familyFromMeta({ fallback: "monospace" })).toBe("mono");
    expect(familyFromMeta(undefined)).toBe("sans");
  });
});

describe("needsUnicodeFont", () => {
  it("is false for text the built-in fonts can encode", () => {
    expect(needsUnicodeFont("Andy Zheng 07/13/2026")).toBe(false);
    expect(needsUnicodeFont("Café — “quoted” • €5")).toBe(false);
    expect(needsUnicodeFont("line1\nline2\t")).toBe(false);
  });

  it("is true for CJK and other non-WinAnsi characters", () => {
    expect(needsUnicodeFont("郑安迪")).toBe(true);
    expect(needsUnicodeFont("Andy 郑")).toBe(true);
    expect(needsUnicodeFont("→")).toBe(true);
  });
});

describe("fitTextSize", () => {
  const measure = (t: string, s: number) => t.length * s * 0.5;

  it("leaves text that already fits alone", () => {
    expect(fitTextSize("abc", 12, 100, measure)).toBe(12);
  });

  it("shrinks text that overflows the original width", () => {
    // 10 字 * 12pt * 0.5 = 60pt 宽,要塞进 45pt → 9pt
    expect(fitTextSize("0123456789", 12, 45, measure)).toBeCloseTo(9, 2);
  });

  it("never shrinks below minRatio", () => {
    expect(fitTextSize("0123456789", 12, 5, measure)).toBeCloseTo(12 * 0.55, 2);
  });

  it("handles empty text and zero width", () => {
    expect(fitTextSize("", 12, 30, measure)).toBe(12);
    expect(fitTextSize("abc", 12, 0, measure)).toBe(12);
  });
});

describe("estimateWidthPt", () => {
  it("counts CJK as full-width and latin as half-width", () => {
    expect(estimateWidthPt("中文", 10)).toBeCloseTo(20, 5);
    expect(estimateWidthPt("abcd", 10)).toBeCloseTo(20.8, 5);
  });
});

describe("page slots", () => {
  const pages: PageSlot[] = [
    { src: 0, rotate: 0 },
    { src: 1, rotate: 0 },
    { src: 2, rotate: 0 },
  ];

  it("moves a page up and down", () => {
    expect(movePageSlot(pages, 1, -1).map((p) => p.src)).toEqual([1, 0, 2]);
    expect(movePageSlot(pages, 1, 1).map((p) => p.src)).toEqual([0, 2, 1]);
  });

  it("refuses to move past the ends", () => {
    expect(movePageSlot(pages, 0, -1)).toBe(pages);
    expect(movePageSlot(pages, 2, 1)).toBe(pages);
  });

  it("deletes a page but never the last one", () => {
    expect(deletePageSlot(pages, 1).map((p) => p.src)).toEqual([0, 2]);
    const one: PageSlot[] = [{ src: 0, rotate: 0 }];
    expect(deletePageSlot(one, 0)).toBe(one);
  });

  it("accumulates rotation modulo 360, staying non-negative", () => {
    let next = rotatePageSlot(pages, 0, 90);
    next = rotatePageSlot(next, 0, 90);
    expect(next[0].rotate).toBe(180);
    next = rotatePageSlot(next, 0, 180);
    expect(next[0].rotate).toBe(0);
    expect(rotatePageSlot(pages, 0, -90)[0].rotate).toBe(270);
  });
});

describe("sampleColors", () => {
  /** 造一张白底 + 深蓝字的 10x10 位图(前两行是字) */
  function bitmap(ink: [number, number, number], bg: [number, number, number]) {
    const w = 10;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const c = y < 2 ? ink : bg;
        rgba[o] = c[0];
        rgba[o + 1] = c[1];
        rgba[o + 2] = c[2];
        rgba[o + 3] = 255;
      }
    }
    return { rgba, w, h };
  }

  it("picks the dark ink and the light background", () => {
    const { rgba, w, h } = bitmap([29, 78, 216], [255, 255, 255]);
    const { ink, bg } = sampleColors(rgba, w, h, { x: 0, y: 0, w, h });
    expect(ink.b).toBeGreaterThan(ink.r);
    expect(ink.r).toBeLessThan(0.3);
    expect(bg.r).toBeCloseTo(1, 2);
  });

  it("reports a tinted background, not plain white", () => {
    const { rgba, w, h } = bitmap([0, 0, 0], [230, 240, 255]);
    const { bg } = sampleColors(rgba, w, h, { x: 0, y: 0, w, h });
    expect(bg.b).toBeGreaterThan(bg.r);
    expect(bg.r).toBeLessThan(1);
  });

  it("does not treat a blank area's noise as ink", () => {
    const { rgba, w, h } = bitmap([252, 252, 252], [255, 255, 255]);
    const { ink } = sampleColors(rgba, w, h, { x: 0, y: 0, w, h });
    expect(ink).toEqual({ r: 0.1, g: 0.1, b: 0.1 });
  });

  it("clamps boxes that fall outside the bitmap", () => {
    const { rgba, w, h } = bitmap([0, 0, 0], [255, 255, 255]);
    expect(() => sampleColors(rgba, w, h, { x: -5, y: -5, w: 100, h: 100 })).not.toThrow();
    const out = sampleColors(rgba, w, h, { x: 50, y: 50, w: 4, h: 4 });
    expect(out.bg).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe("cssToRgb", () => {
  it("parses hex and rgb()", () => {
    expect(cssToRgb("#1d4ed8")).toEqual({ r: 29 / 255, g: 78 / 255, b: 216 / 255 });
    expect(cssToRgb("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0 });
  });

  it("falls back to near-black on garbage", () => {
    expect(cssToRgb("nope")).toEqual({ r: 0.1, g: 0.1, b: 0.1 });
  });
});
