import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  groupIntoLines,
  linesToParagraphs,
  pngFromRaw,
  type PageStats,
  type PositionedItem,
} from "./pdfToWord";

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  opts: Partial<PositionedItem> = {},
): PositionedItem {
  return { str, x, y, width, height: 12, ...opts };
}

const STATS: PageStats = { pageWidth: 612, pageHeight: 792, medianFontSize: 12 };

function paraText(runs: Array<{ text: string }>): string {
  return runs.map((r) => r.text).join("");
}

describe("pngFromRaw", () => {
  it("encodes a 2x2 RGBA image as a valid PNG", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, // red
      0, 255, 0, 255, // green
      0, 0, 255, 255, // blue
      255, 255, 255, 255, // white
    ]);
    const png = pngFromRaw(2, 2, rgba);

    // PNG 魔数
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // 解析 chunk 序列
    const chunks: Array<{ type: string; data: Buffer }> = [];
    let off = 8;
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString("ascii", off + 4, off + 8);
      chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
      off += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(2); // width
    expect(ihdr.readUInt32BE(4)).toBe(2); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type RGBA

    // IDAT 解压后:每行 1 字节 filter(0) + 8 字节像素
    const raw = inflateSync(chunks[1].data);
    expect(raw.length).toBe((2 * 4 + 1) * 2);
    expect(raw[0]).toBe(0);
    expect(raw[9]).toBe(0);
    expect([...raw.subarray(1, 9)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect([...raw.subarray(10, 18)]).toEqual([0, 0, 255, 255, 255, 255, 255, 255]);
  });

  it("rejects mismatched dimensions", () => {
    expect(() => pngFromRaw(3, 3, new Uint8Array(4))).toThrow();
  });
});

describe("groupIntoLines", () => {
  it("merges items on the same visual line and inserts spaces for wide gaps", () => {
    const lines = groupIntoLines([
      // 乱序输入 + 轻微 y 抖动(0.5pt 在容差内)
      item("world", 120, 700.5, 40),
      item("Hello", 72, 700, 40), // 结束于 112,与 120 的间隙 8 > 0.25em(3)
      item("Second", 72, 680, 50),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hello world");
    expect(lines[1].text).toBe("Second");
    // 自上而下排序
    expect(lines[0].y).toBeGreaterThan(lines[1].y);
  });

  it("does not insert a space when the gap is small", () => {
    const lines = groupIntoLines([
      item("Hel", 72, 700, 20),
      item("lo", 92.5, 700, 12), // 间隙 0.5 < 3
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hello");
    expect(lines[0].runs).toHaveLength(1);
  });

  it("detects bold/italic from font names", () => {
    const lines = groupIntoLines([
      item("Bold", 72, 700, 30, { fontFamily: "Helvetica-Bold" }),
      item("Italic", 120, 700, 30, { fontName: "Times-Italic" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].runs).toHaveLength(2);
    expect(lines[0].runs[0]).toMatchObject({ bold: true, italic: false });
    expect(lines[0].runs[1]).toMatchObject({ bold: false, italic: true });
  });
});

describe("linesToParagraphs", () => {
  it("builds heading, wrapped paragraph, and bullets from a synthetic page", () => {
    const lines = groupIntoLines([
      // 居中大字标题(混合大小写 → 应转为标题样式)
      item("Employment Agreement", 206, 720, 200, { height: 18 }),
      // 两行折行正文(行距 15,与标题间距 40)
      item("This is a long paragraph that", 72, 680, 468),
      item("wraps onto a second line.", 72, 665, 200),
      // 项目符号列表
      item("• First item", 90, 635, 150),
      item("• Second item", 90, 620, 160),
    ]);
    const paras = linesToParagraphs(lines, STATS);

    expect(paras).toHaveLength(4);

    expect(paras[0].heading).toBe(1);
    expect(paras[0].alignment).toBe("center");
    expect(paraText(paras[0].runs)).toBe("Employment Agreement");

    // 折行合并成一段,以空格连接
    expect(paras[1].heading).toBe(0);
    expect(paras[1].alignment).toBe("left");
    expect(paraText(paras[1].runs)).toBe(
      "This is a long paragraph that wraps onto a second line.",
    );

    // 每个符号项是独立列表段落,标记已剥离
    expect(paras[2]).toMatchObject({ bullet: true });
    expect(paraText(paras[2].runs)).toBe("First item");
    expect(paras[3]).toMatchObject({ bullet: true });
    expect(paraText(paras[3].runs)).toBe("Second item");
  });

  it("keeps a single-line ALL-CAPS centered title as centered bold, not a heading", () => {
    const lines = groupIntoLines([item("OFFER OF EMPLOYMENT", 206, 720, 200, { height: 16 })]);
    const paras = linesToParagraphs(lines, STATS);
    expect(paras).toHaveLength(1);
    expect(paras[0].heading).toBe(0);
    expect(paras[0].alignment).toBe("center");
    expect(paras[0].runs.every((r) => r.bold)).toBe(true);
    expect(paras[0].fontSize).toBe(16);
  });

  it("classifies right-aligned lines and splits on alignment change", () => {
    const lines = groupIntoLines([
      item("Full width body line ending at the right margin.", 72, 700, 468),
      item("July 13, 2026", 430, 685, 110),
    ]);
    const paras = linesToParagraphs(lines, STATS);
    expect(paras).toHaveLength(2);
    expect(paras[0].alignment).toBe("left");
    expect(paras[1].alignment).toBe("right");
    expect(paraText(paras[1].runs)).toBe("July 13, 2026");
  });

  it("splits paragraphs on large vertical gaps", () => {
    const lines = groupIntoLines([
      item("Para one line one", 72, 700, 200),
      item("para one line two", 72, 685, 200),
      item("Para two after a big gap", 72, 640, 220), // 间距 45 > 1.6×15
      item("para two second line", 72, 625, 200),
    ]);
    const paras = linesToParagraphs(lines, STATS);
    expect(paras).toHaveLength(2);
    expect(paraText(paras[0].runs)).toBe("Para one line one para one line two");
    expect(paraText(paras[1].runs)).toBe("Para two after a big gap para two second line");
  });
});
