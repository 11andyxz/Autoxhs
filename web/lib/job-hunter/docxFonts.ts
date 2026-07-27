/**
 * 给 docx-preview 产出的「保留原格式」HTML 做加固,让它在**浏览器打印、Word、WPS**里都不掉东西。
 * (我们的「下载 Word」其实是 HTML 换个 .doc 后缀,所以 Word/WPS 的 HTML 导入能力也算目标环境。)
 *
 * docx-preview 把 Word 的字体名原样搬进 CSS,于是 .docx 里三类东西会炸掉:
 *
 * 1) **整段文字不可见**。Word 允许 `w:ascii="Times New Roman Bold"` 这种「字重当字体族名」的
 *    写法,也常带 `宋体` / `Cambria` / `Calibri` 这些本机未必装的字体。当一条 font-family
 *    里所有候选都匹配不上时,Chrome 打印出的 PDF 会**给足行宽却一个字形都不画**(PDF 文本层
 *    里也取不到字),在页面上则回退成随机字体。macOS 上尤其明显:一份 Windows Word 简历里的
 *    加粗要点、公司名会整段消失。补一个「本机一定有」的兜底字体即可根治。
 *    注意:只补 `sans-serif` 这类通用族名不够 —— 实测 `font-family: 宋体, sans-serif` 依旧
 *    打印不出来;必须先给一个**具体存在的字体**(Helvetica / Times New Roman),再跟通用族名。
 *
 * 2) **项目符号变成豆腐块 □**。Word 的圆点/方块来自 Symbol、Wingdings 的「符号编码」私用区码位
 *    (U+F0B7、U+F0A7…),docx-preview 原样写进 `content`。macOS 上的 Symbol / Wingdings 是
 *    Unicode 编码、根本没有这些码位,于是渲染成豆腐块。换成等价的 Unicode 字符(• ▪ ✓ …)即可。
 *
 * 3) **WPS 里项目符号整排消失**。符号是 CSS `::before` 生成内容,Word/WPS 的 HTML 导入不认
 *    生成内容,于是 76 个圆点全没了。把字面量 marker 直接写进段落文本即可(有序编号仍交给
 *    CSS 计数器)。
 *
 * 这里的函数都是纯字符串变换、幂等,前后端共用(客户端 docxToHtml、服务端 buildAlignedDoc)。
 */

// ---- 1. 字体兜底 ----

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** 这些关键字整条不是字体列表,别动。 */
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

const SANS_HINT =
  /(arial|helvetica|calibri|aptos|verdana|tahoma|segoe|candara|corbel|trebuchet|century gothic|franklin gothic|futura|gill sans|lato|open sans|roboto|noto sans|source han sans|pingfang|hiragino sans|meiryo|malgun|微软雅黑|雅黑|黑体)/i;
const MONO_HINT =
  /(courier|consolas|monaco|menlo|cascadia|fira code|source code|dejavu sans mono|monospac)/i;

// 兜底链:先给具体字体(Chrome 打印时只有通用族名救不回来),再给通用族名;
// 都带一个中文字体,避免中文简历落到「拉丁字体没有中文字形」的路径上。
const SERIF_TAIL = ["Times New Roman", "Songti SC", "SimSun", "serif"];
const SANS_TAIL = ["Helvetica", "PingFang SC", "Microsoft YaHei", "sans-serif"];
const MONO_TAIL = ["Courier New", "Menlo", "monospace"];

/** Word 常把字重/字形拼进字体名(Times New Roman Bold / Calibri Light),这些词不是族名的一部分。 */
const STYLE_SUFFIX =
  /^(bold|italic|oblique|regular|light|medium|semibold|demibold|demi|book|black|heavy|thin|extrabold|ultrabold|extralight|ultralight|condensed|narrow|expanded|bolditalic|italicmt|boldmt|psmt|mt)$/i;

/** 能安全地以「不加引号」形式写进 CSS 的字体名(纯字母数字与空格,且以字母开头)。 */
const SAFE_UNQUOTED = /^[A-Za-z][A-Za-z0-9 ]*$/;

function unquoteFamily(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:"|'|&quot;|&#34;|&#39;|&apos;)/, "")
    .replace(/(?:"|'|&quot;|&#34;|&#39;|&apos;)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Times New Roman Bold" → "Times New Roman";没有字重后缀时返回 null。 */
function stripStyleSuffix(name: string): string | null {
  const words = name.split(" ").filter(Boolean);
  let changed = false;
  while (words.length > 1 && STYLE_SUFFIX.test(words[words.length - 1])) {
    words.pop();
    changed = true;
  }
  return changed ? words.join(" ") : null;
}

function pickTail(namedFamilies: string[], generics: string[]): string[] {
  // 原本就写了通用族名的,按它的类别兜底,别改变作者意图。
  const generic = generics[generics.length - 1];
  if (generic === "monospace" || generic === "ui-monospace") return MONO_TAIL;
  if (generic === "sans-serif" || generic === "ui-sans-serif" || generic === "system-ui") {
    return SANS_TAIL;
  }
  if (generic) return SERIF_TAIL;

  const joined = namedFamilies.join(" ");
  if (MONO_HINT.test(joined)) return MONO_TAIL;
  if (SANS_HINT.test(joined)) return SANS_TAIL;
  return SERIF_TAIL;
}

/**
 * 给一条 font-family 的值补兜底字体。返回 null 表示「不用改」(空值 / var() / 全局关键字)。
 * 保留原有候选与其引号写法(内联样式里是 &quot;,不能换成裸引号),只在末尾追加。
 */
export function normalizeFontStack(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  // var(--docx-…-font) 之类:值在自定义属性里,单独处理那一条声明即可。
  if (raw.includes("(")) return null;

  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return null;

  const named: string[] = [];
  const namedBare: string[] = [];
  const generics: string[] = [];
  for (const entry of entries) {
    const bare = unquoteFamily(entry);
    const key = bare.toLowerCase();
    if (CSS_WIDE_KEYWORDS.has(key)) return null;
    if (GENERIC_FAMILIES.has(key)) {
      generics.push(key);
      continue;
    }
    named.push(entry);
    namedBare.push(bare);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string) => {
    const key = unquoteFamily(entry).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  named.forEach((entry, i) => {
    push(entry);
    // "Times New Roman Bold" 匹配不上时,紧跟真正的族名 "Times New Roman"。
    const base = stripStyleSuffix(namedBare[i]);
    if (base && SAFE_UNQUOTED.test(base)) push(base);
  });
  for (const tail of pickTail(namedBare, generics)) push(tail);

  const result = out.join(", ");
  return result === raw ? null : result;
}

// 一条声明的值:允许内部出现引号段;遇到未被引号包裹的 ; } " ' < 就结束。
// 注意 HTML 实体要整体吃掉 —— 内联样式里的引号写成 &quot;,它**自带一个分号**,
// 不先匹配掉就会把 `font-family: &quot;Times New Roman&quot;` 截成 `font-family: &quot`。
const ENTITY = `&(?:[a-zA-Z][a-zA-Z0-9]*|#\\d+|#[xX][0-9a-fA-F]+);`;
const VALUE = `(?:${ENTITY}|[^;}"'<]|"[^"]*"|'[^']*')*`;
const FONT_FAMILY_DECL = new RegExp(`(font-family\\s*:\\s*)(${VALUE})`, "gi");
// docx-preview 会把主题字体放进自定义属性(--docx-minorHAnsi-font: Calibri),
// 再用 var() 引用;兜底得补在属性值里。
const FONT_VAR_DECL = new RegExp(`(--[\\w-]*font[\\w-]*\\s*:\\s*)(${VALUE})`, "gi");

/** 给 HTML/CSS 里所有 font-family(含 --*-font 自定义属性)补上兜底字体。幂等。 */
export function addFontFallbacks(html: string): string {
  const fix = (_m: string, head: string, value: string) => {
    const next = normalizeFontStack(value);
    return next === null ? `${head}${value}` : `${head}${next}`;
  };
  return html.replace(FONT_VAR_DECL, fix).replace(FONT_FAMILY_DECL, fix);
}

// ---- 2. Symbol / Wingdings 私用区项目符号 ----

// 私用区码位 = 0xF000 + 该字体「符号编码」下的单字节码。下面按字节码列出常见的项目符号。
const WINGDINGS_BULLETS: Record<number, string> = {
  0x6c: "●",
  0x6d: "❍",
  0x6e: "■",
  0x6f: "❑",
  0x71: "❒",
  0x75: "◆",
  0x9f: "•",
  0xa4: "•",
  0xa7: "▪",
  0xa8: "▫",
  0xd8: "➢",
  0xfc: "✓",
  0xfd: "✗",
  0xfe: "❑",
};

const SYMBOL_BULLETS: Record<number, string> = {
  0x2d: "−",
  0xa7: "♣",
  0xb0: "°",
  0xb7: "•",
  0xd8: "→",
  0xde: "⇒",
};

/** 私用区里没收录的一律当成圆点 —— 这些码位只出现在项目符号上,总比豆腐块强。 */
const FALLBACK_BULLET = "•";

function mapSymbolChar(code: number, fontFamily: string): string {
  const byte = code - 0xf000;
  const table = /wingdings|webdings/i.test(fontFamily) ? WINGDINGS_BULLETS : SYMBOL_BULLETS;
  return table[byte] ?? FALLBACK_BULLET;
}

const PUA_CHAR = /[\uF000-\uF0FF]/g;
// CSS 转义写法:\f0b7 / \0000F0B7(后面可跟一个空白作分隔)
const PUA_ESCAPE = /\\0{0,4}(f0[0-9a-f]{2})[ \t]?/gi;

function replacePua(text: string, fontFamily: string): string {
  return text
    .replace(PUA_ESCAPE, (_m, hex: string) => mapSymbolChar(parseInt(hex, 16), fontFamily))
    .replace(PUA_CHAR, (c) => mapSymbolChar(c.charCodeAt(0), fontFamily));
}

const RULE_BLOCK = /\{([^{}]*)\}/g;
const CONTENT_DECL = /(content\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;
const FONT_FAMILY_IN_BLOCK = new RegExp(`font-family\\s*:\\s*(${VALUE})`, "i");

/**
 * 把 CSS `content` 里 Symbol/Wingdings 的私用区码位换成等价 Unicode 字符,
 * 并去掉该规则上已无意义的 `font-family: Symbol/Wingdings`(留着反而可能没有该字形)。幂等。
 */
export function normalizeSymbolBullets(css: string): string {
  return css.replace(RULE_BLOCK, (block, inner: string) => {
    if (!/content\s*:/i.test(inner)) return block;

    const fontMatch = inner.match(FONT_FAMILY_IN_BLOCK);
    const fontFamily = fontMatch?.[1] ?? "";
    let touched = false;

    let next = inner.replace(CONTENT_DECL, (whole, head: string, quoted: string) => {
      if (!PUA_CHAR.test(quoted) && !PUA_ESCAPE.test(quoted)) return whole;
      // 上面两个正则带 /g,test 会推进 lastIndex,复位后再用。
      PUA_CHAR.lastIndex = 0;
      PUA_ESCAPE.lastIndex = 0;
      touched = true;
      return `${head}${replacePua(quoted, fontFamily)}`;
    });
    PUA_CHAR.lastIndex = 0;
    PUA_ESCAPE.lastIndex = 0;
    if (!touched) return block;

    // 换成 Unicode 后就不该再指定符号字体了,让它跟随正文字体。
    if (/symbol|wingdings|webdings/i.test(fontFamily)) {
      next = next.replace(new RegExp(`font-family\\s*:\\s*${VALUE};?`, "i"), "");
    }
    return `{${next}}`;
  });
}

// ---- 3. 把 CSS 生成的项目符号落成真实字符 ----

// docx-preview 用 `p.docx-num-1-0:before { content: "•\9" }` 画项目符号。浏览器认,
// **Word / WPS 的 HTML 导入不认 ::before 生成内容** —— 我们的 .doc 其实是 HTML 换了个后缀,
// 用 WPS 打开就会看到所有圆点凭空消失。把纯字面量的 marker 直接写进段落里,三边都认。
//
// 只处理「纯字符串」的 content;带 counter() 的有序列表编号必须留给 CSS 计数器算。
// 前面的 (^|[}>\n]) 是规则边界:docx-preview 一行一条规则,首条紧跟 <style> 的 ">"。
const BULLET_RULE = /(^|[}>\n])\s*p\.(docx-num-[\w-]+)\s*:{1,2}before\s*\{([^}]*)\}/g;
const LITERAL_CONTENT = /content\s*:\s*"((?:[^"\\]|\\.)*)"/i;

/** CSS 字符串字面量 → 实际文本(处理 \9 制表符、\XXXX 码位与 \" 转义)。 */
function decodeCssString(raw: string): string {
  return raw.replace(/\\([0-9a-fA-F]{1,6})[ \t]?|\\(.)/g, (_m, hex?: string, ch?: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? ""),
  );
}

/**
 * 把 `p.docx-num-*:before` 里的字面量 marker 写进段落文本,并把该 content 置空
 * (保留规则本身,`counter-increment` 还要给嵌套编号用)。幂等:第二次跑时 content 已为空。
 */
export function inlineListMarkers(html: string): string {
  // 1) 先只**读**出候选 marker,别急着改 CSS。
  const markers = new Map<string, string>();
  for (const m of html.matchAll(BULLET_RULE)) {
    const literal = m[3].match(LITERAL_CONTENT);
    if (!literal) continue; // content: counter(...) 之类,编号交给 CSS 计数器
    const text = decodeCssString(literal[1]).replace(/[\t\n\r]+/g, " ").trim();
    if (text) markers.set(m[2], text);
  }
  if (!markers.size) return html;

  // 2) 写进段落。marker 后跟不间断空格:段首的普通空格会被 HTML 折叠掉。
  const used = new Set<string>();
  const out = html.replace(
    /<p\b([^>]*\bclass="([^"]*)"[^>]*)>/gi,
    (whole, attrs: string, cls: string) => {
      const hit = cls.split(/\s+/).find((c) => markers.has(c));
      if (!hit) return whole;
      used.add(hit);
      return `<p${attrs}>${markers.get(hit)}\u00a0`;
    },
  );
  if (!used.size) return html;

  // 3) 只清空**确实搬走了**的那些,免得把没段落用到的符号弄丢;
  //    规则本身保留 —— counter-increment 还要给嵌套编号用。
  return out.replace(BULLET_RULE, (whole, lead: string, cls: string, body: string) =>
    used.has(cls)
      ? `${lead}p.${cls}:before{${body.replace(LITERAL_CONTENT, 'content: ""')}}`
      : whole,
  );
}

// ---- 4. 给 Word / WPS 的页面设置 ----

const SECTION_TAG = /<section\b[^>]*\bclass="[^"]*\bdocx\b[^"]*"[^>]*\bstyle="([^"]*)"/i;

function pt(style: string, prop: string): string | null {
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)pt`, "i"));
  return m ? m[1] : null;
}

/** padding 简写 → [上, 右, 下, 左]。 */
function paddingBox(style: string): [string, string, string, string] | null {
  const m = style.match(/(?:^|;)\s*padding\s*:\s*([^;]+)/i);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/);
  if (!parts.length || parts.length > 4 || parts.some((p) => !/^[\d.]+pt$/.test(p))) return null;
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

/**
 * docx-preview 把页面尺寸/页边距放在 `<section class="docx" style="width/min-height/padding">` 上。
 * 浏览器认这个盒子,**Word / WPS 的 HTML 导入不认** —— 于是 .doc 打开就是一篇没有页边距、
 * 铺满整个窗口的网页。翻译成 Word 自己的 `@page WordSection1` 约定它才认。
 *
 * 这段 CSS 放进 MSO 条件注释里:浏览器把它当普通注释完全跳过(不会影响已验证的打印结果),
 * 只有 Word/WPS 会读。返回 null 表示这份 HTML 没有可用的页面尺寸,不注入。
 */
export function wordPageSetup(bodyHtml: string): string | null {
  const style = bodyHtml.match(SECTION_TAG)?.[1];
  if (!style) return null;
  const width = pt(style, "width");
  const height = pt(style, "min-height");
  const pad = paddingBox(style);
  if (!width || !height || !pad) return null;

  return `<!--[if gte mso 9]><style>
  @page WordSection1 { size: ${width}pt ${height}pt; margin: ${pad.join(" ")}; }
  div.WordSection1 { page: WordSection1; }
</style><![endif]-->`;
}

/**
 * 转换刚出炉时用:只修字体与符号码位。
 * **不**落地项目符号 —— marker 要留到模型改写之后再落,否则模型可能把它当正文删掉/复制乱。
 */
export function hardenDocxStyles(html: string): string {
  return addFontFallbacks(normalizeSymbolBullets(html));
}

/**
 * 出稿(预览 / 打印 / 下载 .doc)前用:在 hardenDocxStyles 之上,把 CSS 里的项目符号落成
 * 真实字符。要在**完整文档**(样式 + 正文在一起)上调用,否则找不到 marker 对应的段落。幂等。
 */
export function hardenDocxHtml(html: string): string {
  return inlineListMarkers(hardenDocxStyles(html));
}
