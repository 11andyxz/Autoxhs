import { describe, expect, it } from "vitest";

import {
  buildPrintCss,
  buildShellHtml,
  normalizeFontFamily,
  resolveChromePath,
} from "./wordToPdf";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";

describe("buildPrintCss", () => {
  it("去掉 docx-preview 外层灰底/内边距与 section 阴影(避免和文档页边距叠加、页面发灰)", () => {
    const css = buildPrintCss("letter");
    expect(css).toContain(".docx-wrapper");
    expect(css).toContain("padding: 0 !important");
    expect(css).toContain("box-shadow: none !important");
  });

  it("@page margin:0(页边距由 docx-preview 的 section padding 提供,不再硬编码)", () => {
    expect(buildPrintCss("letter")).toContain("margin: 0");
  });

  it("按纸张设置 @page size", () => {
    expect(buildPrintCss("letter")).toContain("size: letter");
    expect(buildPrintCss("a4")).toContain("size: A4");
  });
});

describe("buildShellHtml", () => {
  it("含 doctype、charset 与打印样式,body 为空(内容由 docx-preview 注入)", () => {
    const html = buildShellHtml("letter");
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("size: letter");
    expect(html).toContain("<body></body>");
  });
});

describe("normalizeFontFamily", () => {
  it("把 '<字体> Bold' 脸名还原成基础族并标记 bold,中文族换成可嵌入的 Heiti SC", () => {
    const r = normalizeFontFamily('"Times New Roman Bold", 宋体');
    expect(r.changed).toBe(true);
    expect(r.bold).toBe(true);
    expect(r.italic).toBe(false);
    expect(r.value).toBe('"Times New Roman", "Heiti SC"');
  });

  it("识别 Bold Italic 组合,基础族无空格时不加引号", () => {
    const r = normalizeFontFamily("Arial Bold Italic");
    expect(r.bold).toBe(true);
    expect(r.italic).toBe(true);
    expect(r.value).toBe("Arial");
  });

  it("Italic / Oblique 脸名标记 italic", () => {
    expect(normalizeFontFamily('"Calibri Italic"').italic).toBe(true);
    expect(normalizeFontFamily("Helvetica Oblique").italic).toBe(true);
  });

  it("以中文族为首选(拉丁文会丢字)时,补上文档主拉丁族到最前", () => {
    const r = normalizeFontFamily("宋体", '"Times New Roman"');
    expect(r.changed).toBe(true);
    expect(r.value).toBe('"Times New Roman", "Heiti SC"');
  });

  it("没有可用 baseLatin 时,仍把中文族换成 Heiti SC(至少能显影)", () => {
    const r = normalizeFontFamily("宋体");
    expect(r.value).toBe('"Heiti SC"');
  });

  it("拉丁族在前、中文族在后:拉丁族保留,中文族换 Heiti SC,不补前缀", () => {
    const r = normalizeFontFamily('"Times New Roman", 宋体', '"Times New Roman"');
    expect(r.value).toBe('"Times New Roman", "Heiti SC"');
  });

  it("PingFang / 微软雅黑 等不可嵌入中文族也归一到 Heiti SC", () => {
    expect(normalizeFontFamily("PingFang SC", '"Arial"').value).toBe('"Arial", "Heiti SC"');
    expect(normalizeFontFamily("微软雅黑", '"Arial"').value).toBe('"Arial", "Heiti SC"');
  });

  it("普通拉丁字体族不改动", () => {
    const r = normalizeFontFamily('"Times New Roman", serif');
    expect(r.changed).toBe(false);
    expect(r.value).toBe('"Times New Roman", serif');
  });

  it("不误伤名字里本就含 Bold 但非后缀的族名", () => {
    const r = normalizeFontFamily('"Bold Sans Display"');
    expect(r.changed).toBe(false);
  });
});

describe("resolveChromePath", () => {
  it("env 路径存在时优先返回 env", () => {
    expect(resolveChromePath(() => true, "/custom/chrome")).toBe("/custom/chrome");
  });

  it("env 路径不存在时回退到 Chrome", () => {
    const exists = (p: string) => p === CHROME;
    expect(resolveChromePath(exists, "/custom/chrome")).toBe(CHROME);
  });

  it("Chrome 不存在时回退到 Chromium", () => {
    const exists = (p: string) => p === CHROMIUM;
    expect(resolveChromePath(exists)).toBe(CHROMIUM);
  });

  it("都不存在时返回 null", () => {
    expect(resolveChromePath(() => false)).toBeNull();
    expect(resolveChromePath(() => false, "/custom/chrome")).toBeNull();
  });

  it("未传 env 时不影响候选顺序", () => {
    expect(resolveChromePath(() => true)).toBe(CHROME);
  });
});
