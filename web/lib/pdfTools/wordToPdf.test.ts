import { describe, expect, it } from "vitest";

import { buildPrintHtml, resolveChromePath } from "./wordToPdf";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";

describe("buildPrintHtml", () => {
  it("包含 charset meta、样式和正文", () => {
    const body = '<h1>标题</h1><p>Hello <strong>world</strong></p>';
    const html = buildPrintHtml(body);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<style>");
    expect(html).toContain(body);
    expect(html).toContain("</html>");
  });

  it("正文原样嵌入,不做转义", () => {
    const body = '<img src="data:image/png;base64,AAAA">';
    expect(buildPrintHtml(body)).toContain(body);
  });

  it("包含关键打印样式", () => {
    const html = buildPrintHtml("<p>x</p>");
    expect(html).toContain("font-size: 11pt");
    expect(html).toContain("border-collapse: collapse");
    expect(html).toContain("max-width: 100%");
    expect(html).toContain("padding-left: 2em");
  });

  it("中文字体栈里 Heiti SC 在 PingFang 之前(无头打印时 PingFang 字形无法嵌入)", () => {
    const html = buildPrintHtml("<p>x</p>");
    const heiti = html.indexOf('"Heiti SC"');
    const pingfang = html.indexOf('"PingFang SC"');
    expect(heiti).toBeGreaterThan(-1);
    expect(pingfang).toBeGreaterThan(-1);
    expect(heiti).toBeLessThan(pingfang);
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
