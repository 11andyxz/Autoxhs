import { describe, expect, it } from "vitest";

import {
  buildAlignedDoc,
  extractGoogleDocId,
  htmlToText,
  restoreImages,
  restoreStyles,
  sanitizeModelHtml,
  splitHtmlDoc,
  stashImages,
  stashStyles,
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

describe("stashStyles / restoreStyles", () => {
  it("相同 style 复用同一编号,还原后完全一致", () => {
    const html =
      '<p style="font-size:11pt">a</p><span style="color:red">b</span><p style="font-size:11pt">c</p>';
    const { html: stashed, styles } = stashStyles(html);
    expect(styles).toEqual(["font-size:11pt", "color:red"]);
    // 两个相同 style 复用 data-s="0"
    expect(stashed).toBe('<p data-s="0">a</p><span data-s="1">b</span><p data-s="0">c</p>');
    expect(restoreStyles(stashed, styles)).toBe(html);
  });

  it("模型克隆出的额外 data-s 也能还原;越界编号丢弃", () => {
    const { styles } = stashStyles('<p style="color:red">x</p>');
    // 模型复制了一个同样的 bullet(复用 data-s="0"),又幻觉了一个 data-s="9"
    const modelOut = '<p data-s="0">x</p><p data-s="0">new</p><p data-s="9">bad</p>';
    expect(restoreStyles(modelOut, styles)).toBe(
      '<p style="color:red">x</p><p style="color:red">new</p><p >bad</p>',
    );
  });

  it("保留 style 里的 HTML 实体(如 &quot;),还原进 style 属性正确", () => {
    const html = '<span style="font-family: &quot;Times New Roman&quot;">t</span>';
    const { html: stashed, styles } = stashStyles(html);
    expect(stashed).toBe('<span data-s="0">t</span>');
    expect(restoreStyles(stashed, styles)).toBe(html);
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

describe("splitHtmlDoc", () => {
  it("拆出 <style> 与 <body> 内部", () => {
    const html =
      '<!doctype html><html><head><style>.docx{color:red}</style></head><body><div class="docx-wrapper"><p>hi</p></div></body></html>';
    const { styleHtml, body } = splitHtmlDoc(html);
    expect(styleHtml).toBe("<style>.docx{color:red}</style>");
    expect(body).toBe('<div class="docx-wrapper"><p>hi</p></div>');
  });

  it("没有 <body> 时,剥掉 head/style 后当正文", () => {
    const { styleHtml, body } = splitHtmlDoc("<style>x{}</style><p>only body</p>");
    expect(styleHtml).toBe("<style>x{}</style>");
    expect(body).toBe("<p>only body</p>");
  });
});

describe("htmlToText", () => {
  it("提取可读文本:分段、项目符号、实体解码,去标签", () => {
    const html =
      '<h1>Andy</h1><p>Email: <a href="x">a@b.com</a></p><ul><li>Java</li><li>Spring &amp; Kafka</li></ul>';
    const t = htmlToText(html);
    expect(t).toContain("Andy");
    expect(t).toContain("a@b.com");
    expect(t).toContain("• Java");
    expect(t).toContain("Spring & Kafka"); // &amp; 解码
    expect(t).not.toMatch(/<[a-z]/i); // 不含标签
  });

  it("去掉 <script>/<style>,不把其内容当正文", () => {
    expect(htmlToText('<p>ok</p><script>steal()</script><style>p{}</style>')).toBe("ok");
  });
});

describe("buildAlignedDoc", () => {
  it("拼回原样式 + 打印样式,body 原样嵌入(不再套 .page)", () => {
    const doc = buildAlignedDoc("<p>hello</p>", "<style>.docx{color:red}</style>");
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<style>.docx{color:red}</style>"); // 原样式保留
    expect(doc).toContain("<body><p>hello</p></body>"); // body 原样,无 .page 包裹
    expect(doc).toContain("@page { margin: 0; }"); // 打印样式
  });
});
