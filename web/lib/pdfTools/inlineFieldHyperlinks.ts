import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * 把 Word「复杂域超链接」(HYPERLINK complex field)改写成原生 <w:hyperlink> 元素。
 *
 * 背景:很多简历(如本仓库遇到的这份)不是用 <w:hyperlink r:id> 存超链接,而是用一段
 * **复杂域**:<w:fldChar begin> + <w:instrText> HYPERLINK "url" </w:instrText> +
 * <w:fldChar separate> + 显示文本若干 run + <w:fldChar end>。docx-preview 0.4.0 的 renderRun
 * 里有 `if (elem.fieldRun) return null` —— **任何含 fldChar/instrText 的 run 整个丢弃**。
 * 偏偏这份文档把结束符 <w:fldChar end> 和最后一段显示文本放在**同一个 run** 里
 * (邮箱的 "@gmail.com"、LinkedIn 的整条 URL),于是这些文字连同链接在打印出的 PDF 里整段消失。
 *
 * 解决:在喂给 docx-preview 之前,把 HYPERLINK 复杂域转成 docx-preview 能正确渲染成 <a href> 的
 * 原生 <w:hyperlink>(外部关系写进 document.xml.rels,TargetMode="External")。顺带把域控制 run
 * (begin/separate/instrText/end)剥掉、只保留显示文本 run,既恢复文字又让链接可点击。
 * 非 HYPERLINK 的复杂域(PAGE/DATE 等)不加链接,但同样保留其显示文本(剥掉控制 run),避免同类丢字。
 *
 * 稳健性:逐段处理,遇到预期外的结构(嵌套域、未闭合域等)就**跳过该段、保持原样**,
 * 绝不产出损坏的 XML;整体失败由调用方兜底回退到原始 docx。纯字符串进出,便于单测。
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

type El = Element;

function toArray(nl: NodeListOf<ChildNode> | HTMLCollectionOf<Element>): ChildNode[] {
  const out: ChildNode[] = [];
  for (let i = 0; i < nl.length; i++) {
    const item = (nl as { item(i: number): ChildNode | null }).item?.(i) ?? (nl as unknown as ChildNode[])[i];
    if (item) out.push(item);
  }
  return out;
}

function isElement(n: ChildNode | null): n is El {
  return !!n && n.nodeType === 1;
}

/** cloneNode 的返回类型是 Node,这里收窄回 ChildNode 便于放进子节点数组。 */
function cloneChild(n: ChildNode): ChildNode {
  return n.cloneNode(true) as unknown as ChildNode;
}

function localNameOf(n: ChildNode): string {
  const el = n as El;
  return el.localName || (el.nodeName || "").split(":").pop() || "";
}

/** 读 w: 前缀属性,兼容命名空间两种取法。 */
function wAttr(el: El, name: string): string {
  return el.getAttribute("w:" + name) || el.getAttributeNS(W_NS, name) || "";
}

/** 是否是仅含空白的文本节点(document.xml 通常无缩进空白,但稳妥处理)。 */
function isWhitespaceText(n: ChildNode): boolean {
  return n.nodeType === 3 && !(n.textContent || "").trim();
}

/** 元素内部是否含可见文本(后代有非空 <w:t>)。 */
function elementHasText(el: El): boolean {
  const ts = el.getElementsByTagName("w:t");
  for (let i = 0; i < ts.length; i++) {
    if ((ts[i]?.textContent || "").length > 0) return true;
  }
  return false;
}

/**
 * 解析域指令:仅当以 HYPERLINK 开头才算超链接。
 * 支持 `HYPERLINK "url"`、开关 `\l "anchor"`(书签)、`\* MERGEFORMAT` 等尾随开关。
 * 返回 null 表示这不是超链接域(交由上层保留其显示文本、但不加链接)。
 */
export function parseHyperlinkInstruction(
  instr: string,
): { url: string; anchor: string } | null {
  const s = instr.trim();
  const m = /^HYPERLINK\b([\s\S]*)$/i.exec(s);
  if (!m) return null;
  const rest = m[1];
  let anchor = "";
  const lm = /\\l\s+"([^"]*)"/i.exec(rest);
  if (lm) anchor = lm[1];
  // 主目标总在最前,且开关(\x)只出现在其后。先取**开头**的带引号字符串:URL 里的反斜杠
  //(file:/// 或 UNC 路径)不能被当成开关切断——否则会把 "file:///C:\Users\..." 截成 "file:///C:"。
  let url = "";
  const quoted = /^\s*"([^"]*)"/.exec(rest);
  if (quoted) {
    url = quoted[1].trim();
  } else {
    // 无引号目标:才用「第一个开关之前的第一个裸词」
    const bare = rest.split(/\\[A-Za-z]/)[0].trim();
    if (bare) url = bare.split(/\s+/)[0];
  }
  if (!url && !anchor) return null;
  return { url, anchor };
}

type Token =
  | { kind: "keep"; node: ChildNode } // 原样保留(克隆)的节点
  | { kind: "content"; rPr: El | null; children: ChildNode[] } // 从控制 run 拆出的显示内容
  | { kind: "instr"; text: string }
  | { kind: "fldchar"; type: string };

/**
 * 把一组节点展开成 token 流:普通 run/其它节点原样保留;含 fldChar/instrText 的 run 在
 * 子节点层拆分,使控制符(begin/separate/instrText/end)与显示内容分离——因为它们可能同处一个 run。
 *
 * 「简单域」<w:fldSimple w:instr=...>显示 run</w:fldSimple> 展开成与复杂域**等价**的 token
 * 序列(begin/instr/separate/子节点/end),从而复用同一状态机:HYPERLINK 简单域同样转成可点击
 * <w:hyperlink>,其它简单域保留文字。否则 docx-preview 0.4.0 没有 fldSimple 渲染分支,会把整个
 * fldSimple 子树(含邮箱/URL 文本)整段丢弃。
 */
function tokenizeNodes(nodes: ChildNode[]): Token[] {
  const tokens: Token[] = [];
  for (const node of nodes) {
    if (isElement(node) && localNameOf(node) === "fldSimple") {
      tokens.push({ kind: "fldchar", type: "begin" });
      tokens.push({ kind: "instr", text: wAttr(node, "instr") });
      tokens.push({ kind: "fldchar", type: "separate" });
      tokens.push(...tokenizeNodes(toArray(node.childNodes)));
      tokens.push({ kind: "fldchar", type: "end" });
      continue;
    }
    if (!isElement(node) || localNameOf(node) !== "r") {
      tokens.push({ kind: "keep", node });
      continue;
    }
    const runChildren = toArray(node.childNodes);
    const hasControl = runChildren.some(
      (c) => isElement(c) && (localNameOf(c) === "fldChar" || localNameOf(c) === "instrText"),
    );
    if (!hasControl) {
      tokens.push({ kind: "keep", node });
      continue;
    }
    // 拆分控制 run:遇到控制符就把已累积的显示内容 flush 成一个 content token。
    let rPr: El | null = null;
    let pending: ChildNode[] = [];
    const flush = () => {
      if (pending.length) {
        tokens.push({ kind: "content", rPr, children: pending });
        pending = [];
      }
    };
    for (const c of runChildren) {
      if (isElement(c)) {
        const ln = localNameOf(c);
        if (ln === "rPr") {
          rPr = c;
          continue;
        }
        if (ln === "fldChar") {
          flush();
          tokens.push({ kind: "fldchar", type: wAttr(c, "fldCharType") });
          continue;
        }
        if (ln === "instrText") {
          flush();
          tokens.push({ kind: "instr", text: c.textContent || "" });
          continue;
        }
      }
      pending.push(c); // 显示内容(w:t / w:br / w:tab / w:drawing …)或裸文本节点
    }
    flush();
  }
  return tokens;
}

function tokenizeParagraph(p: El): Token[] {
  return tokenizeNodes(toArray(p.childNodes));
}

/** 用克隆的 rPr + 克隆的显示内容,组装一个新的 <w:r>。 */
function buildRun(doc: Document, rPr: El | null, children: ChildNode[]): El {
  const r = doc.createElementNS(W_NS, "w:r") as unknown as El;
  if (rPr) r.appendChild(rPr.cloneNode(true));
  for (const c of children) r.appendChild(c.cloneNode(true));
  return r;
}

class BailError extends Error {}

/**
 * 处理单个段落。成功则原地重建其子节点并返回 true;若结构预期外,抛 BailError(上层跳过、保持原样)。
 * 关键:遍历期间**只读原节点、只造克隆/新节点**,直到最后一步才整体替换子节点——因此 bail 时段落零改动。
 */
function transformParagraph(p: El, doc: Document, addRel: (url: string) => string): boolean {
  const tokens = tokenizeParagraph(p);
  if (!tokens.some((t) => t.kind === "fldchar" || t.kind === "instr")) return false;

  type State = "outside" | "instr" | "display";
  let state: State = "outside";
  let instr = "";
  let display: El[] = [];
  const out: ChildNode[] = [];
  let sawField = false;

  const finalize = () => {
    const parsed = parseHyperlinkInstruction(instr);
    if (parsed) {
      const hl = doc.createElementNS(W_NS, "w:hyperlink") as unknown as El;
      if (parsed.url) hl.setAttributeNS(R_NS, "r:id", addRel(parsed.url));
      if (parsed.anchor) hl.setAttributeNS(W_NS, "w:anchor", parsed.anchor);
      for (const d of display) hl.appendChild(d);
      out.push(hl);
    } else {
      // 非超链接域:丢掉控制符,但保留显示文本,避免同类丢字。
      for (const d of display) out.push(d);
    }
  };

  const pushDisplay = (node: ChildNode) => {
    display.push(cloneChild(node) as El);
  };

  for (const tok of tokens) {
    if (tok.kind === "keep") {
      if (isWhitespaceText(tok.node)) {
        if (state === "outside") out.push(cloneChild(tok.node));
        else if (state === "display") pushDisplay(tok.node);
        // instr 状态下的空白忽略
        continue;
      }
      if (state === "outside") {
        out.push(cloneChild(tok.node));
      } else if (state === "display") {
        // 显示区里:普通 run 收进显示内容;非 run 元素若含可见文本且本域是超链接,
        // 包进 <w:hyperlink> 会被 docx-preview 的 parseHyperlink(只认 <w:r> 子节点)丢字 →
        // 放弃该段(保持原样,至少不比基线差)。无文本的结构节点(书签等)照常收进即可(会被安全忽略)。
        const node = tok.node;
        if (isElement(node) && localNameOf(node) !== "r" && elementHasText(node) && parseHyperlinkInstruction(instr)) {
          throw new BailError();
        }
        pushDisplay(node);
      } else {
        throw new BailError(); // 指令区里出现实体内容,结构异常
      }
      continue;
    }
    if (tok.kind === "content") {
      const run = buildRun(doc, tok.rPr, tok.children);
      if (state === "outside") out.push(run);
      else if (state === "display") display.push(run);
      else throw new BailError();
      continue;
    }
    if (tok.kind === "instr") {
      if (state !== "instr") throw new BailError();
      instr += tok.text;
      continue;
    }
    // fldchar
    if (tok.type === "begin") {
      if (state !== "outside") throw new BailError(); // 不支持嵌套域
      state = "instr";
      instr = "";
      display = [];
      sawField = true;
    } else if (tok.type === "separate") {
      if (state !== "instr") throw new BailError();
      state = "display";
    } else if (tok.type === "end") {
      if (state === "outside") throw new BailError();
      finalize();
      state = "outside";
      instr = "";
      display = [];
    } else {
      throw new BailError(); // 未知 fldCharType
    }
  }
  if (state !== "outside") throw new BailError(); // 域未闭合
  if (!sawField) return false;

  while (p.firstChild) p.removeChild(p.firstChild);
  for (const n of out) p.appendChild(n);
  return true;
}

/** 返回一个新增外部超链接关系的函数;相同 Target 复用同一 Id,新 Id 从现有最大 rIdN 递增。 */
function makeRelAdder(relsDoc: Document, relsRoot: El) {
  let maxNum = 0;
  const byTarget = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const node of toArray(relsRoot.childNodes)) {
    if (!isElement(node)) continue;
    const id = node.getAttribute("Id") || "";
    if (id) usedIds.add(id);
    const mm = /^rId(\d+)$/.exec(id);
    if (mm) maxNum = Math.max(maxNum, parseInt(mm[1], 10));
    if (
      node.getAttribute("Type") === HYPERLINK_REL_TYPE &&
      node.getAttribute("TargetMode") === "External"
    ) {
      const t = node.getAttribute("Target");
      if (t) byTarget.set(t, id);
    }
  }
  let added = 0;
  let counter = maxNum;
  const addRel = (url: string): string => {
    const existing = byTarget.get(url);
    if (existing) return existing;
    let id: string;
    do {
      counter++;
      id = "rId" + counter;
    } while (usedIds.has(id));
    usedIds.add(id);
    byTarget.set(url, id);
    const rel = relsDoc.createElementNS(PKG_REL_NS, "Relationship") as unknown as El;
    rel.setAttribute("Id", id);
    rel.setAttribute("Type", HYPERLINK_REL_TYPE);
    rel.setAttribute("Target", url);
    rel.setAttribute("TargetMode", "External");
    relsRoot.appendChild(rel);
    added++;
    return id;
  };
  return { addRel, addedCount: () => added };
}

const EMPTY_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PKG_REL_NS}"></Relationships>`;

export type InlineResult = {
  documentXml: string;
  relsXml: string | null;
  changed: boolean;
};

/**
 * 把 document.xml 里的 HYPERLINK 复杂域改写成原生 <w:hyperlink>,并把外部关系补进 rels。
 * @param documentXml word/document.xml 原文
 * @param relsXml word/_rels/document.xml.rels 原文(可为 null:文档没有该文件)
 * @returns 改写后的两份 XML 与是否有改动;无改动时原样返回,relsXml 未新增关系时也原样返回。
 */
export function inlineFieldHyperlinks(documentXml: string, relsXml: string | null): InlineResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, "text/xml") as unknown as Document;
  const relsDoc = parser.parseFromString(
    relsXml && relsXml.trim() ? relsXml : EMPTY_RELS,
    "text/xml",
  ) as unknown as Document;
  const relsRoot = relsDoc.documentElement as unknown as El;
  const { addRel, addedCount } = makeRelAdder(relsDoc, relsRoot);

  const paragraphs = toArray(doc.getElementsByTagName("w:p")).filter(isElement);
  let changed = false;
  for (const p of paragraphs) {
    try {
      if (transformParagraph(p, doc, addRel)) changed = true;
    } catch {
      /* 该段结构预期外,保持原样 */
    }
  }

  if (!changed) return { documentXml, relsXml, changed: false };

  const serializer = new XMLSerializer();
  const outDoc = serializer.serializeToString(doc as unknown as Node);
  const relsChanged = addedCount() > 0;
  const outRels = relsChanged
    ? serializer.serializeToString(relsDoc as unknown as Node)
    : relsXml;
  return { documentXml: outDoc, relsXml: outRels, changed: true };
}
