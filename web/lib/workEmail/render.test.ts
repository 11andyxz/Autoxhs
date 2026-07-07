import { describe, expect, it } from "vitest";

import { renderEmailHtml } from "./render";

describe("renderEmailHtml", () => {
  it("renders ## as a heading", () => {
    const html = renderEmailHtml("## Section One");
    expect(html).toContain("<h3");
    expect(html).toContain("Section One");
  });

  it("groups consecutive - bullets into a single <ul>", () => {
    const html = renderEmailHtml("- a\n- b\n- c");
    expect((html.match(/<ul/g) ?? []).length).toBe(1);
    expect((html.match(/<li/g) ?? []).length).toBe(3);
  });

  it("groups numbered items into a single <ol>", () => {
    const html = renderEmailHtml("1. first\n2. second");
    expect((html.match(/<ol/g) ?? []).length).toBe(1);
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  it("a blank line breaks a list into two separate lists", () => {
    const ul = renderEmailHtml("- a\n- b\n\n- c");
    expect((ul.match(/<ul/g) ?? []).length).toBe(2);
    const ol = renderEmailHtml("1. a\n\n1. b");
    expect((ol.match(/<ol/g) ?? []).length).toBe(2);
  });

  it("converts **bold** to <strong>", () => {
    const html = renderEmailHtml("This is **important** text");
    expect(html).toContain("<strong>important</strong>");
  });

  it("splits paragraphs on blank lines and keeps single newlines as <br>", () => {
    const html = renderEmailHtml("line one\nline two\n\nsecond para");
    expect((html.match(/<p/g) ?? []).length).toBe(2);
    expect(html).toContain("line one<br/>line two");
  });

  it("escapes HTML so injected markup cannot execute (XSS safe)", () => {
    const html = renderEmailHtml('<img src=x onerror="alert(1)"> and <script>evil()</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes inside bullets and headings too", () => {
    const html = renderEmailHtml("## <b>x</b>\n- <i>y</i>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>y</i>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;i&gt;");
  });
});
