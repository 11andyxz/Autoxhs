import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { inlineFieldHyperlinks, parseHyperlinkInstruction } from "./inlineFieldHyperlinks";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const HL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
const rels = (inner = "") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${inner}</Relationships>`;

/** 复杂域超链接:begin+instrText+separate 同处一个 run,end 与最后一段显示文本同处一个 run(镜像真实简历)。 */
const complexField = (instr: string, displayRuns: string[]) => {
  const runs = [...displayRuns];
  const last = runs.pop() ?? "";
  // 把 end 塞进最后一个显示 run 里(还原「end 与文字同 run」这个致命结构)
  const lastWithEnd = last.replace("</w:r>", `<w:fldChar w:fldCharType="end"/></w:r>`);
  return (
    `<w:r><w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve">${instr}</w:instrText><w:fldChar w:fldCharType="separate"/></w:r>` +
    runs.join("") +
    lastWithEnd
  );
};

const styledRun = (text: string) =>
  `<w:r><w:rPr><w:rStyle w:val="8"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

// 解析输出、查询 <w:hyperlink> 与 rels
function parse(xml: string) {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}
function hyperlinks(d: Document) {
  return Array.from(
    { length: d.getElementsByTagName("w:hyperlink").length },
    (_, i) => d.getElementsByTagName("w:hyperlink")[i],
  );
}
function relEntries(xml: string) {
  const d = parse(xml);
  const list = d.getElementsByTagName("Relationship");
  return Array.from({ length: list.length }, (_, i) => {
    const e = list[i];
    return {
      id: e.getAttribute("Id"),
      type: e.getAttribute("Type"),
      target: e.getAttribute("Target"),
      mode: e.getAttribute("TargetMode"),
    };
  });
}

describe("parseHyperlinkInstruction", () => {
  it("提取 mailto / http 目标", () => {
    expect(parseHyperlinkInstruction(' HYPERLINK "mailto:a@b.com" ')).toEqual({
      url: "mailto:a@b.com",
      anchor: "",
    });
    expect(parseHyperlinkInstruction(' HYPERLINK "http://x.com/p?q=1" ')).toEqual({
      url: "http://x.com/p?q=1",
      anchor: "",
    });
  });

  it("忽略尾随开关(\\* MERGEFORMAT),取主 URL", () => {
    expect(parseHyperlinkInstruction(' HYPERLINK "http://x.com" \\* MERGEFORMAT ')?.url).toBe(
      "http://x.com",
    );
  });

  it("识别 \\l 书签锚点(可与 URL 并存或单独存在)", () => {
    expect(parseHyperlinkInstruction(' HYPERLINK \\l "sec1" ')).toEqual({ url: "", anchor: "sec1" });
    expect(parseHyperlinkInstruction(' HYPERLINK "http://x.com" \\l "sec1" ')).toEqual({
      url: "http://x.com",
      anchor: "sec1",
    });
  });

  it("非 HYPERLINK 域返回 null", () => {
    expect(parseHyperlinkInstruction(" PAGE ")).toBeNull();
    expect(parseHyperlinkInstruction(" TOC \\o ")).toBeNull();
    expect(parseHyperlinkInstruction("")).toBeNull();
  });
});

describe("inlineFieldHyperlinks — 邮箱(显示文本跨 3 个 run,end 与 @gmail.com 同 run)", () => {
  const input = doc(
    `<w:p>${styledRun("Email: ")}${complexField(
      ' HYPERLINK "mailto:andyxiongzheng@gmail.com" ',
      [styledRun("andy"), styledRun("xiongzheng"), styledRun("@gmail.com")],
    )}</w:p>`,
  );

  it("生成 <w:hyperlink r:id>,完整保留显示文本,且不再有 fldChar/instrText", () => {
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    expect(res.documentXml).not.toContain("fldChar");
    expect(res.documentXml).not.toContain("instrText");

    const d = parse(res.documentXml);
    const hls = hyperlinks(d);
    expect(hls).toHaveLength(1);
    // 关键回归:@gmail.com 不能丢
    expect(hls[0].textContent).toBe("andyxiongzheng@gmail.com");
    expect(hls[0].getAttribute("r:id")).toMatch(/^rId\d+$/);
    // "Email: " 前缀仍在超链接之外
    expect(d.getElementsByTagName("w:p")[0].textContent).toBe("Email: andyxiongzheng@gmail.com");
  });

  it("rels 里新增 mailto 外部关系,Id 与超链接一致", () => {
    const res = inlineFieldHyperlinks(input, rels());
    const entries = relEntries(res.relsXml!);
    const mail = entries.find((e) => e.target === "mailto:andyxiongzheng@gmail.com");
    expect(mail).toBeTruthy();
    expect(mail!.type).toBe(HL_TYPE);
    expect(mail!.mode).toBe("External");
    const rid = parse(res.documentXml).getElementsByTagName("w:hyperlink")[0].getAttribute("r:id");
    expect(mail!.id).toBe(rid);
  });
});

describe("inlineFieldHyperlinks — LinkedIn(整条 URL 与 end 同 run)", () => {
  const input = doc(
    `<w:p>${styledRun("LinkedIn: ")}${complexField(
      ' HYPERLINK "http://www.linkedin.com/in/andy-xiong-4b2bab274" ',
      [styledRun("www.linkedin.com/in/andy-xiong-4b2bab274")],
    )}</w:p>`,
  );

  it("整条 URL 文本不丢,包进可点击的 <w:hyperlink>", () => {
    const res = inlineFieldHyperlinks(input, rels());
    const hls = hyperlinks(parse(res.documentXml));
    expect(hls).toHaveLength(1);
    expect(hls[0].textContent).toBe("www.linkedin.com/in/andy-xiong-4b2bab274");
    const entries = relEntries(res.relsXml!);
    expect(entries.some((e) => e.target === "http://www.linkedin.com/in/andy-xiong-4b2bab274")).toBe(
      true,
    );
  });
});

describe("inlineFieldHyperlinks — 关系 Id 生成", () => {
  it("避开已有 rId,从最大值递增;相同 URL 复用同一 Id", () => {
    const input = doc(
      `<w:p>${complexField(' HYPERLINK "http://x.com" ', [styledRun("x")])}</w:p>` +
        `<w:p>${complexField(' HYPERLINK "http://x.com" ', [styledRun("x2")])}</w:p>`,
    );
    const existing = rels(
      `<Relationship Id="rId1" Type="styles" Target="styles.xml"/><Relationship Id="rId7" Type="theme" Target="theme.xml"/>`,
    );
    const res = inlineFieldHyperlinks(input, existing);
    const hls = hyperlinks(parse(res.documentXml));
    expect(hls).toHaveLength(2);
    // 两个 hyperlink 指向同一 URL → 复用同一 Id
    expect(hls[0].getAttribute("r:id")).toBe(hls[1].getAttribute("r:id"));
    // 新 Id 不能撞已有的 rId1 / rId7
    const newId = hls[0].getAttribute("r:id")!;
    expect(["rId1", "rId7"]).not.toContain(newId);
    expect(parseInt(newId.replace("rId", ""), 10)).toBeGreaterThan(7);
    // 只新增了一个关系
    expect(relEntries(res.relsXml!).filter((e) => e.type === HL_TYPE)).toHaveLength(1);
  });
});

describe("inlineFieldHyperlinks — 非超链接域 / 无域 / 异常结构", () => {
  it("非 HYPERLINK 域(PAGE):保留显示文本,不加链接、不新增关系", () => {
    const input = doc(`<w:p>${complexField(" PAGE ", [styledRun("12")])}</w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    expect(res.documentXml).not.toContain("fldChar");
    expect(hyperlinks(parse(res.documentXml))).toHaveLength(0);
    // 页码文字保留
    expect(parse(res.documentXml).getElementsByTagName("w:p")[0].textContent).toBe("12");
    // 没有新增关系 → relsXml 原样返回
    expect(res.relsXml).toBe(rels());
  });

  it("没有任何域:原样返回,changed=false", () => {
    const input = doc(`<w:p>${styledRun("plain text")}</w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(false);
    expect(res.documentXml).toBe(input);
    expect(res.relsXml).toBe(rels());
  });

  it("嵌套域(begin 里再 begin):跳过该段、保持原样,不产出损坏 XML", () => {
    const nested =
      `<w:r><w:fldChar w:fldCharType="begin"/><w:instrText> HYPERLINK "http://x.com" </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` + // 第二个 begin → 嵌套
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${styledRun("x")}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const input = doc(`<w:p>${nested}</w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    // 该段无法安全转换 → 整体 changed=false、原样返回
    expect(res.changed).toBe(false);
    expect(res.documentXml).toBe(input);
  });

  it("一段能转、另一段异常:能转的转、异常的保持原样", () => {
    const good = `<w:p>${complexField(' HYPERLINK "http://ok.com" ', [styledRun("ok")])}</w:p>`;
    const unterminated = `<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> HYPERLINK "http://bad.com" </w:instrText><w:fldChar w:fldCharType="separate"/></w:r>${styledRun("dangling")}</w:p>`;
    const res = inlineFieldHyperlinks(doc(`${good}${unterminated}`), rels());
    expect(res.changed).toBe(true);
    const hls = hyperlinks(parse(res.documentXml));
    // 只转了 ok 那段
    expect(hls).toHaveLength(1);
    expect(hls[0].textContent).toBe("ok");
    // 未闭合那段的文字仍在(未损坏)
    expect(res.documentXml).toContain("dangling");
    // bad.com 未成为关系
    expect(relEntries(res.relsXml!).some((e) => e.target === "http://bad.com")).toBe(false);
  });
});

// 复杂域,显示区为任意 XML,end 单独成 run(便于放 smartTag / 书签等)
const complexFieldRaw = (instr: string, displayXml: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve">${instr}</w:instrText><w:fldChar w:fldCharType="separate"/></w:r>` +
  displayXml +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

describe("parseHyperlinkInstruction — 含反斜杠的目标(file:/// / UNC)不被截断", () => {
  it("file:/// Windows 路径完整保留", () => {
    expect(parseHyperlinkInstruction(' HYPERLINK "file:///C:\\Users\\me\\CV.pdf" ')?.url).toBe(
      "file:///C:\\Users\\me\\CV.pdf",
    );
  });
  it("UNC 路径完整保留", () => {
    expect(parseHyperlinkInstruction(' HYPERLINK "\\\\server\\share\\resume.docx" ')?.url).toBe(
      "\\\\server\\share\\resume.docx",
    );
  });
  it("含反斜杠路径 + 尾随开关:仍取完整路径", () => {
    expect(
      parseHyperlinkInstruction(' HYPERLINK "file:///C:\\a\\b.pdf" \\* MERGEFORMAT ')?.url,
    ).toBe("file:///C:\\a\\b.pdf");
  });
});

describe("inlineFieldHyperlinks — 简单域 w:fldSimple", () => {
  it("HYPERLINK 简单域:转成可点击 <w:hyperlink>,文本保留,新增外部关系", () => {
    const input = doc(
      `<w:p>${styledRun("Email: ")}<w:fldSimple w:instr='HYPERLINK "mailto:a@b.com"'>${styledRun("a@b.com")}</w:fldSimple></w:p>`,
    );
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    expect(res.documentXml).not.toContain("fldSimple");
    const hls = hyperlinks(parse(res.documentXml));
    expect(hls).toHaveLength(1);
    expect(hls[0].textContent).toBe("a@b.com");
    expect(relEntries(res.relsXml!).some((e) => e.target === "mailto:a@b.com")).toBe(true);
  });

  it("非 HYPERLINK 简单域(PAGE):去掉 fldSimple 包裹但保留显示文本,不加链接", () => {
    const input = doc(`<w:p><w:fldSimple w:instr=" PAGE ">${styledRun("7")}</w:fldSimple></w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    expect(res.documentXml).not.toContain("fldSimple");
    expect(hyperlinks(parse(res.documentXml))).toHaveLength(0);
    expect(parse(res.documentXml).getElementsByTagName("w:p")[0].textContent).toBe("7");
  });
});

describe("inlineFieldHyperlinks — 显示区含非 run 元素", () => {
  it("超链接域显示区被 <w:smartTag> 包裹(含文本):放弃转换、保持原样,文本不丢", () => {
    const display = `<w:smartTag><w:r><w:rPr><w:rStyle w:val="8"/></w:rPr><w:t>a@b.com</w:t></w:r></w:smartTag>`;
    const input = doc(`<w:p>${complexFieldRaw(' HYPERLINK "mailto:a@b.com" ', display)}</w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    // 不能包进 <w:hyperlink>(会丢字)→ 该段整体保持原样
    expect(res.changed).toBe(false);
    expect(res.documentXml).toBe(input);
    expect(res.documentXml).toContain("a@b.com");
  });

  it("超链接域显示区含无文本书签:仍正常转换(书签被安全忽略)", () => {
    const display =
      `<w:bookmarkStart w:id="1" w:name="x"/><w:bookmarkEnd w:id="1"/>` +
      `<w:r><w:rPr><w:rStyle w:val="8"/></w:rPr><w:t>a@b.com</w:t><w:fldChar w:fldCharType="end"/></w:r>`;
    const input = doc(
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> HYPERLINK "mailto:a@b.com" </w:instrText><w:fldChar w:fldCharType="separate"/></w:r>${display}</w:p>`,
    );
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    const hls = hyperlinks(parse(res.documentXml));
    expect(hls).toHaveLength(1);
    expect(hls[0].textContent).toBe("a@b.com");
  });

  it("非超链接域显示区含 smartTag:不放弃,unwrap 保留文本", () => {
    const display = `<w:smartTag><w:r><w:t>5</w:t></w:r></w:smartTag>`;
    const input = doc(`<w:p>${complexFieldRaw(" PAGEREF _x ", display)}</w:p>`);
    const res = inlineFieldHyperlinks(input, rels());
    expect(res.changed).toBe(true);
    expect(hyperlinks(parse(res.documentXml))).toHaveLength(0);
    expect(parse(res.documentXml).getElementsByTagName("w:p")[0].textContent).toBe("5");
  });
});
