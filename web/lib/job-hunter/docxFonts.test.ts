import { describe, expect, it } from "vitest";

import {
  addFontFallbacks,
  hardenDocxHtml,
  inlineListMarkers,
  normalizeFontStack,
  normalizeSymbolBullets,
} from "./docxFonts";

describe("normalizeFontStack", () => {
  it("补上真实字体 + 通用族名(光有通用族名 Chrome 打印时救不回来)", () => {
    expect(normalizeFontStack("Cambria")).toBe(
      "Cambria, Times New Roman, Songti SC, SimSun, serif",
    );
  });

  it("把 Word 的伪字体名(Times New Roman Bold)降级到真正的族名", () => {
    expect(normalizeFontStack('"Times New Roman Bold", 宋体')).toBe(
      '"Times New Roman Bold", Times New Roman, 宋体, Songti SC, SimSun, serif',
    );
  });

  it("内联样式里的 &quot; 原样保留(不能换成裸引号)", () => {
    expect(normalizeFontStack("&quot;Times New Roman Bold&quot;, 宋体")).toBe(
      "&quot;Times New Roman Bold&quot;, Times New Roman, 宋体, Songti SC, SimSun, serif",
    );
  });

  it("无衬线字体走无衬线兜底", () => {
    expect(normalizeFontStack("Calibri, Arial")).toBe(
      "Calibri, Arial, Helvetica, PingFang SC, Microsoft YaHei, sans-serif",
    );
  });

  it("等宽字体走等宽兜底", () => {
    expect(normalizeFontStack("'Courier New'")).toBe("'Courier New', Menlo, monospace");
  });

  it("原本就写了通用族名的,按它的类别兜底,不改变作者意图", () => {
    expect(normalizeFontStack("Calibri, serif")).toBe(
      "Calibri, Times New Roman, Songti SC, SimSun, serif",
    );
  });

  it("幂等:已经加固过的不再变化", () => {
    const once = normalizeFontStack("Cambria")!;
    expect(normalizeFontStack(once)).toBeNull();
  });

  it("var() / 全局关键字 / 空值不动", () => {
    expect(normalizeFontStack("var(--docx-minorHAnsi-font)")).toBeNull();
    expect(normalizeFontStack("inherit")).toBeNull();
    expect(normalizeFontStack("   ")).toBeNull();
  });

  it("不误伤真实存在、结尾像字重的族名(Arial Black 仍排第一)", () => {
    expect(normalizeFontStack('"Arial Black"')).toBe(
      '"Arial Black", Arial, Helvetica, PingFang SC, Microsoft YaHei, sans-serif',
    );
  });
});

describe("addFontFallbacks", () => {
  it("同时覆盖 <style> 里的规则和元素上的内联样式", () => {
    const html =
      '<style>p.docx_10 span { font-family: Cambria; font-size: 11pt; }</style>' +
      '<p><span style="font-family: 宋体; font-weight: bold;">TikTok</span></p>';
    const out = addFontFallbacks(html);
    expect(out).toContain("font-family: Cambria, Times New Roman, Songti SC, SimSun, serif;");
    expect(out).toContain(
      'style="font-family: 宋体, Times New Roman, Songti SC, SimSun, serif; font-weight: bold;"',
    );
  });

  it("内联样式里的 &quot; 自带分号,不能把声明截断", () => {
    const out = addFontFallbacks(
      '<span style="font-family: &quot;Times New Roman&quot;; font-weight: bold;">Andy</span>',
    );
    expect(out).toBe(
      '<span style="font-family: &quot;Times New Roman&quot;, Songti SC, SimSun, serif;' +
        ' font-weight: bold;">Andy</span>',
    );
  });

  it("docx-preview 的主题字体自定义属性也要兜底(font-family 只写了 var())", () => {
    const out = addFontFallbacks(
      ":root { --docx-minorHAnsi-font: Calibri; } p span { font-family: var(--docx-minorHAnsi-font); }",
    );
    expect(out).toContain(
      "--docx-minorHAnsi-font: Calibri, Helvetica, PingFang SC, Microsoft YaHei, sans-serif;",
    );
    expect(out).toContain("font-family: var(--docx-minorHAnsi-font);");
  });
});

describe("normalizeSymbolBullets", () => {
  it("Symbol 的 U+F0B7 换成圆点,并去掉已无意义的 font-family", () => {
    const out = normalizeSymbolBullets(
      'p.docx-num-1-0:before { content: "\uF0B7\\9"; font-family: Symbol; color: black; }',
    );
    expect(out).toContain('content: "•\\9"');
    expect(out).not.toContain("Symbol");
    expect(out).toContain("color: black;");
  });

  it("Wingdings 的 U+F0A7 换成小方块(与 Symbol 表不同)", () => {
    const out = normalizeSymbolBullets(
      'p.docx-num-1-2:before { content: "\uF0A7\\9"; font-family: Wingdings; }',
    );
    expect(out).toContain('content: "▪\\9"');
  });

  it("CSS 转义写法 \\f0b7 一样处理", () => {
    const out = normalizeSymbolBullets(
      'li:before { content: "\\f0b7 "; font-family: Symbol; }',
    );
    expect(out).toContain('content: "•"');
  });

  it("不碰普通 content 与非符号字体", () => {
    const css = 'p.docx-num-1-1:before { content: "o\\9"; font-family: \'Courier New\'; }';
    expect(normalizeSymbolBullets(css)).toBe(css);
  });

  it("幂等", () => {
    const once = normalizeSymbolBullets(
      'p:before { content: "\uF0B7\\9"; font-family: Symbol; }',
    );
    expect(normalizeSymbolBullets(once)).toBe(once);
  });
});

describe("inlineListMarkers", () => {
  const css = 'p.docx-num-1-0:before { content: "•\\9"; counter-increment: docx-num-1-0; }';

  it("把字面量 marker 写进段落,并清空 content(Word/WPS 不认 ::before)", () => {
    const out = inlineListMarkers(
      `<style>${css}</style><p class="docx_10 docx-num-1-0" style="x">Hello</p>`,
    );
    expect(out).toContain('<p class="docx_10 docx-num-1-0" style="x">•\u00a0Hello</p>');
    expect(out).toContain('content: ""');
    // counter-increment 得留着,嵌套编号还要用
    expect(out).toContain("counter-increment: docx-num-1-0");
  });

  it("有序列表的 counter() 编号交给 CSS,不动", () => {
    const src =
      '<style>p.docx-num-2-0:before { content: counter(docx-num-2-0, decimal) ". "; }</style>' +
      '<p class="docx-num-2-0">Item</p>';
    expect(inlineListMarkers(src)).toBe(src);
  });

  it("幂等:第二次跑 content 已为空,不会插第二个符号", () => {
    const once = inlineListMarkers(`<style>${css}</style><p class="docx-num-1-0">Hello</p>`);
    expect(inlineListMarkers(once)).toBe(once);
    expect(once.match(/•/g)).toHaveLength(1);
  });
});

describe("hardenDocxHtml", () => {
  it("项目符号换掉后,该规则不会再被补上 Symbol 的兜底字体", () => {
    const out = hardenDocxHtml(
      '<style>p.docx-num-1-0:before { content: "\uF0B7\\9"; font-family: Symbol; }</style>',
    );
    expect(out).toContain("•");
    expect(out).not.toContain("Symbol");
  });

  it("整体幂等", () => {
    const src =
      '<style>p:before { content: "\uF0B7\\9"; font-family: Symbol; }</style>' +
      '<span style="font-family: &quot;Times New Roman Bold&quot;, 宋体;">x</span>';
    const once = hardenDocxHtml(src);
    expect(hardenDocxHtml(once)).toBe(once);
  });
});
