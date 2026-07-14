import { describe, expect, it } from "vitest";

import {
  buildAlignedDoc,
  extractGoogleDocId,
  restoreImages,
  sanitizeModelHtml,
  stashImages,
} from "./align";

describe("extractGoogleDocId", () => {
  it("提取 /document/d/{id} 形式", () => {
    expect(
      extractGoogleDocId(
        "https://docs.google.com/document/d/16ycCmEB-sTDxkMcdkCdreBBTMN2NmAd8GaMhQuPDXfk/edit?tab=t.0",
      ),
    ).toBe("16ycCmEB-sTDxkMcdkCdreBBTMN2NmAd8GaMhQuPDXfk");
  });

  it("提取 ?id= 形式", () => {
    expect(
      extractGoogleDocId("https://docs.google.com/document/u/0/?id=ABC-123_xyz"),
    ).toBe("ABC-123_xyz");
  });

  it("拒绝非 docs.google.com 主机(SSRF 防护)", () => {
    expect(extractGoogleDocId("https://evil.com/document/d/abc/edit")).toBeNull();
    expect(
      // 子域伪装也应拒绝
      extractGoogleDocId("https://docs.google.com.evil.com/document/d/abc"),
    ).toBeNull();
  });

  it("拒绝非法 URL / 空串 / 缺 id", () => {
    expect(extractGoogleDocId("not a url")).toBeNull();
    expect(extractGoogleDocId("")).toBeNull();
    expect(extractGoogleDocId("https://docs.google.com/spreadsheets/d/")).toBeNull();
  });
});

describe("stashImages / restoreImages", () => {
  it("占位后可原样还原(往返)", () => {
    const html =
      '<p>hi</p><img src="data:image/png;base64,AAAA" alt="x"><p>bye</p><img src="data:image/png;base64,BBBB">';
    const { html: stashed, images } = stashImages(html);
    expect(images).toHaveLength(2);
    expect(stashed).toContain('<img data-imgref="0">');
    expect(stashed).toContain('<img data-imgref="1">');
    expect(stashed).not.toContain("base64,AAAA");
    expect(restoreImages(stashed, images)).toBe(html);
  });

  it("模型给占位加了属性也能还原", () => {
    const { html: stashed, images } = stashImages('<img src="data:x">');
    const modelOut = stashed.replace('<img data-imgref="0">', '<img data-imgref="0" alt="photo">');
    expect(restoreImages(modelOut, images)).toBe('<img src="data:x">');
  });

  it("模型删掉了占位 → 对应图片丢弃,不报错", () => {
    const { images } = stashImages('<img src="data:x">');
    expect(restoreImages("<p>no image here</p>", images)).toBe("<p>no image here</p>");
  });
});

describe("sanitizeModelHtml", () => {
  it("去掉 ```html 代码围栏", () => {
    expect(sanitizeModelHtml("```html\n<p>hi</p>\n```")).toBe("<p>hi</p>");
    expect(sanitizeModelHtml("```\n<p>hi</p>\n```")).toBe("<p>hi</p>");
  });

  it("围栏前后有解释文字也能取出内容(结尾闲聊是模型常见习惯)", () => {
    expect(
      sanitizeModelHtml("```html\n<h1>Hi</h1>\n```\nLet me know if you need changes."),
    ).toBe("<h1>Hi</h1>");
    expect(
      sanitizeModelHtml("Here is your resume:\n```html\n<h1>Hi</h1>\n```"),
    ).toBe("<h1>Hi</h1>");
  });

  it("未闭合围栏 / 无围栏但有前言,都能清掉", () => {
    expect(sanitizeModelHtml("```html\n<h1>Hi</h1>")).toBe("<h1>Hi</h1>");
    expect(sanitizeModelHtml("Sure! <h1>Hi</h1><p>x</p>")).toBe("<h1>Hi</h1><p>x</p>");
  });

  it("从完整文档里取出 body 内部", () => {
    const doc = "<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>";
    expect(sanitizeModelHtml(doc)).toBe("<p>hi</p>");
  });

  it("删除 <script> / <style> 块", () => {
    const out = sanitizeModelHtml('<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>');
    expect(out).toBe("<p>a</p><p>b</p>");
  });

  it("删除内联事件处理器(含无引号)与 javascript: 链接", () => {
    const out = sanitizeModelHtml(
      `<p onclick="steal()">a</p><a href="javascript:evil()">x</a>`,
    );
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  it("删除无引号事件处理器(<img onerror=…> 常见 XSS 向量)", () => {
    const out = sanitizeModelHtml('<img data-imgref="0" onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/i);
    // 占位属性仍在,才能被 restoreImages 还原
    expect(out).toMatch(/data-imgref="0"/);
  });

  it("删除 <iframe>/<object>/<meta> 等危险元素", () => {
    const out = sanitizeModelHtml(
      '<p>ok</p><iframe src="//evil"></iframe><object data="x"></object><meta http-equiv="refresh" content="0;url=//evil">',
    );
    expect(out).toBe("<p>ok</p>");
  });
});

describe("buildAlignedDoc", () => {
  it("把 body 片段包成可打印文档,含打印样式", () => {
    const doc = buildAlignedDoc("<p>hello</p>");
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain('<main class="page"><p>hello</p></main>');
    expect(doc).toContain("@page { size: Letter; margin: 0; }");
  });
});
