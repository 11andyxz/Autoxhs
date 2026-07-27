/**
 * 把一份 CardOutline 拼成一页自包含 HTML：N 个 720×960 的 <section class="card">
 * 竖排，puppeteer 逐个元素截图（deviceScaleFactor=2 → 1440×1920 物理像素）。
 *
 * 一次 setContent 渲染整叠、而不是一张一页反复 setContent：字体只解码一次，
 * 8 张卡的渲染时间基本等于 1 张。
 *
 * 安全区（baoyu references/elements/canvas.md:17-35）：
 *  - 底部 10% 会被小红书的标题栏压住 → 正文下边距留足，只放水印/页码
 *  - 右上角有点赞/分享按钮 → 角标放左上
 *  - 右下角是水印位 → 水印放这里
 */
import { fontFaceCss } from "./fonts";
import { browserFitScript } from "./fit";
import { buildLayoutHtml, esc } from "./layouts";
import { STYLES, resolvePalette, type Palette, type Style } from "./tokens";
import { CSS_HEIGHT, CSS_WIDTH, type Card, type CardOutline } from "./types";

/** 底纹：纯 CSS 渐变实现，无外部资源，保证可复现。 */
function bgPatternCss(style: Style, p: Palette): string {
  switch (style.bgPattern) {
    case "grid":
      return `background-image:
        repeating-linear-gradient(0deg, ${p.line} 0 1px, transparent 1px 40px),
        repeating-linear-gradient(90deg, ${p.line} 0 1px, transparent 1px 40px);`;
    case "dots":
      return `background-image: radial-gradient(${p.line} 1.6px, transparent 1.7px);
        background-size: 26px 26px;`;
    case "paper":
      return `background-image:
        radial-gradient(circle at 20% 15%, rgba(255,255,255,.55), transparent 45%),
        radial-gradient(circle at 82% 78%, rgba(0,0,0,.035), transparent 40%);`;
    case "chalk":
      return `background-image:
        radial-gradient(circle at 30% 20%, rgba(255,255,255,.05), transparent 55%),
        radial-gradient(circle at 75% 85%, rgba(255,255,255,.035), transparent 50%);`;
    default:
      return "";
  }
}

/**
 * 标题强调形状：给标题加下划线 / 高亮底 / 色块。
 * 一律作用在 .title > span（行内元素）上 —— 作用在块级 .title 会拖到整行宽度，
 * 最后一行短的时候装饰会突出去一大截。
 */
function accentCss(style: Style): string {
  const inlineBox = `.title span{box-decoration-break:clone;-webkit-box-decoration-break:clone;}`;
  switch (style.accentShape) {
    case "underline":
      return `${inlineBox}
        .title span{background-image:linear-gradient(var(--accent),var(--accent));
        background-repeat:no-repeat;background-size:100% .16em;background-position:0 96%;}`;
    case "highlight":
      return `${inlineBox}
        .title span{background-image:linear-gradient(var(--accent),var(--accent));
        background-repeat:no-repeat;background-size:100% .34em;background-position:0 88%;}`;
    case "block":
      return `${inlineBox}
        .title span{padding:.04em .18em;background:var(--accent);color:var(--onAccent);}`;
    default:
      return "";
  }
}

/** 序号徽标形状。 */
function numberCss(style: Style): string {
  const base = `.num{flex:none;display:inline-flex;align-items:center;justify-content:center;
    font-family:'XhsSans';font-weight:700;font-size:.92em;line-height:1;}`;
  switch (style.numberStyle) {
    case "circle":
      return `${base}
        .num{width:1.85em;height:1.85em;border-radius:50%;background:var(--accent);color:var(--onAccent);}`;
    case "square":
      return `${base}
        .num{width:1.8em;height:1.8em;border-radius:.22em;background:var(--accent);color:var(--onAccent);}`;
    default:
      return `${base}
        .num{min-width:1.5em;color:var(--accent);font-size:1.05em;}`;
  }
}

/**
 * 深色背景上用白字、浅色上用黑字 —— 决定序号徽标、分组 chip 里的字色。
 * 分区色(zones)在不同配色下亮度差很大（notion 的浅蓝 vs chalkboard 的亮黄），
 * 直接拿它当文字色会看不清，所以一律做成色块 + 自动对比字色。
 */
function onAccent(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // 相对亮度（sRGB 近似），> 0.62 视为浅色
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#1A1A1A" : "#FFFFFF";
}

function deckCss(outline: CardOutline, fontFaces: string): string {
  const style = STYLES[outline.style];
  const p = resolvePalette(outline.style, outline.palette);
  const border = style.border ?? "none";
  const shadow = style.shadow ?? "none";

  return `${fontFaces}
:root { color-scheme: light; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#8a8a8a; }

.card {
  position:relative; width:${CSS_WIDTH}px; height:${CSS_HEIGHT}px; overflow:hidden;
  background:${p.bg};
  --bg:${p.bg}; --surface:${p.surface}; --ink:${p.ink}; --sub:${p.sub};
  --line:${p.line}; --accent:${p.accent}; --onAccent:${onAccent(p.accent)};
  --zone0:${p.zones[0]}; --zone1:${p.zones[1]}; --zone2:${p.zones[2]}; --zone3:${p.zones[3]};
  --zoneInk0:${onAccent(p.zones[0])}; --zoneInk1:${onAccent(p.zones[1])};
  --zoneInk2:${onAccent(p.zones[2])}; --zoneInk3:${onAccent(p.zones[3])};
  --radius:${style.radius}px; --gap:${style.gap}px;
  --border:${border}; --shadow:${shadow};
  font-family:'XhsSans','Heiti SC',sans-serif;
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
}
.card::before { content:""; position:absolute; inset:0; ${bgPatternCss(style, p)} }

/* 内容区：左右 56、上 64、下 104（底部 10% 是小红书标题栏遮挡区，只放水印/页码） */
.inner {
  --fs:20px;
  position:absolute; inset:0; z-index:1;
  padding:64px 56px 104px;
  font-size:var(--fs);
  display:flex; flex-direction:column;
  overflow:hidden;
}

/* 角标放左上：右上角是点赞/分享按钮的遮挡区 */
.badge {
  align-self:flex-start; margin-bottom:.9em;
  font-size:.82em; font-weight:700; letter-spacing:.08em;
  padding:.38em .85em; border-radius:999px;
  background:var(--accent); color:var(--onAccent);
}

.title {
  font-family:${style.displayTitle ? "'XhsDisplay'" : "'XhsSans'"};
  font-weight:700; line-height:1.34; letter-spacing:${style.titleTracking};
  font-size:2.2em; color:var(--ink);
}
.subtitle { margin-top:.7em; font-size:1.05em; line-height:1.55; color:var(--sub); }
${accentCss(style)}

/* 正文区紧跟标题下方（不居中）：居中会让短内容浮在卡中间、上下各空一片，
   看起来像没排好；顶部对齐 + 留白统一沉到底部安全区，才是常见的小红书知识卡长相。 */
.body { flex:1; min-height:0; margin-top:1.5em; display:flex; flex-direction:column; }

/* ---- 封面 / 结尾：大标题居中，正文区留白 ---- */
.card.k-cover .inner, .card.k-ending .inner { justify-content:center; padding-bottom:120px; }
.card.k-cover .title, .card.k-ending .title { font-size:3.5em; line-height:1.2; }
.card.k-cover .subtitle, .card.k-ending .subtitle { margin-top:1em; font-size:1.25em; }
.card.k-cover .body, .card.k-ending .body { flex:none; margin-top:1.6em; }
.sparse-mark { width:2.6em; height:.36em; border-radius:.18em; background:var(--accent); }

/* ---- balanced ---- */
.bal { display:flex; flex-direction:column; gap:var(--gap); flex:none; }
.bal-item {
  display:flex; gap:.85em; align-items:flex-start;
  background:var(--surface); border:var(--border); border-radius:var(--radius);
  box-shadow:var(--shadow); padding:1.05em 1.15em;
}
.bal-dot { flex:none; width:.62em; height:.62em; border-radius:50%; background:var(--accent); margin-top:.5em; }
.bal-text { font-size:1.05em; line-height:1.5; }

/* ---- dense ---- */
.den { display:flex; flex-direction:column; gap:calc(var(--gap) * .62); flex:none; }
.den-item {
  background:var(--surface); border-radius:var(--radius);
  border-left:.32em solid var(--zone);
  box-shadow:var(--shadow);
  padding:.72em .9em;
}
.den-text { font-size:.95em; line-height:1.45; }

/* ---- list ---- */
.lst { display:flex; flex-direction:column; gap:var(--gap); flex:none; }
.lst-item {
  display:flex; gap:.8em; align-items:flex-start;
  background:var(--surface); border:var(--border); border-radius:var(--radius);
  box-shadow:var(--shadow); padding:.9em 1.05em;
}
.lst-text { font-size:1.02em; line-height:1.5; padding-top:.1em; }
${numberCss(style)}

/* ---- flow ---- */
.flw { display:flex; flex-direction:column; align-items:stretch; flex:none; }
.flw-step {
  display:flex; gap:.8em; align-items:flex-start;
  background:var(--surface); border-radius:var(--radius);
  border-left:.32em solid var(--zone); box-shadow:var(--shadow);
  padding:.85em 1em;
}
.flw-text { font-size:1em; line-height:1.5; padding-top:.1em; }
.flw-arrow { text-align:center; color:var(--accent); font-size:1.15em; line-height:1; padding:.32em 0; }

/* ---- comparison ----
   flex:none + min-height：给 flex:1 会把栏拉到满高、底下空一大片；纯 auto 高又太瘦。
   取「至少占正文区 62%」，短内容也有分量，长内容照样往下长。 */
.cmp { display:flex; gap:.9em; flex:none; align-items:stretch; min-height:74%; }
.cmp-col {
  flex:1; display:flex; flex-direction:column;
  background:var(--surface); border-radius:var(--radius); box-shadow:var(--shadow);
  border-top:.4em solid var(--zone); padding:1.3em 1.1em 1.5em; min-width:0;
}
.cmp-head {
  align-self:flex-start; font-weight:700; font-size:1.1em; margin-bottom:.9em;
  padding:.32em .8em; border-radius:.45em; background:var(--zone); color:var(--zoneInk);
}
.cmp-items { display:flex; flex-direction:column; gap:.8em; }
.cmp-item { display:flex; gap:.55em; font-size:1em; line-height:1.5; }
.cmp-item i { flex:none; width:.44em; height:.44em; border-radius:50%; background:var(--zone); margin-top:.55em; }
.cmp-div { width:1px; background:var(--line); align-self:stretch; }

/* ---- quadrant ---- */
.qd {
  display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr;
  gap:.85em; flex:none; min-height:78%;
}
.qd-cell {
  background:var(--surface); border-radius:var(--radius); box-shadow:var(--shadow);
  border-top:.4em solid var(--zone); padding:1.1em 1em 1.2em; min-width:0; overflow:hidden;
}
.qd-head {
  display:inline-block; font-weight:700; font-size:1em; margin-bottom:.65em;
  padding:.28em .7em; border-radius:.4em; background:var(--zone); color:var(--zoneInk);
}
.qd-items { display:flex; flex-direction:column; gap:.5em; }
.qd-item { font-size:.92em; line-height:1.45; }

/* ---- 要点里的 label ---- */
.ilabel {
  display:inline-block; margin-right:.5em; font-weight:700; color:var(--accent);
}

/* ---- 水印 / 页码：落在底部安全区里 ---- */
.watermark {
  position:absolute; right:56px; bottom:44px; z-index:2;
  font-size:15px; font-weight:600; color:var(--sub); opacity:.82;
}
.pager {
  position:absolute; left:56px; bottom:44px; z-index:2;
  font-size:15px; font-weight:600; color:var(--sub); opacity:.6; letter-spacing:.06em;
}
`;
}

function cardHtml(card: Card, index: number, total: number, watermark: string | null): string {
  const badge = card.badge ? `<div class="badge">${esc(card.badge)}</div>` : "";
  const subtitle = card.subtitle
    ? `<p class="subtitle">${esc(card.subtitle)}</p>`
    : "";
  const wm = watermark ? `<div class="watermark">${esc(watermark)}</div>` : "";
  // 封面不标页码（第一眼不该看到「1/8」）
  const pager = index === 0 ? "" : `<div class="pager">${index + 1} / ${total}</div>`;

  return `<section class="card k-${card.kind} l-${card.layout}" data-idx="${index}">
  <div class="inner">
    ${badge}
    <h1 class="title"><span>${esc(card.title)}</span></h1>
    ${subtitle}
    <main class="body">${buildLayoutHtml(card)}</main>
  </div>
  ${wm}${pager}
</section>`;
}

/** 拼出整叠卡片的完整 HTML（自包含：字体内联、无外部请求）。 */
export async function buildDeckHtml(outline: CardOutline): Promise<string> {
  const fontFaces = await fontFaceCss();
  const total = outline.cards.length;
  const sections = outline.cards
    .map((card, i) => cardHtml(card, i, total, outline.watermark))
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>${deckCss(outline, fontFaces)}</style>
</head>
<body>
${sections}
<script>${browserFitScript()}</script>
</body>
</html>`;
}
