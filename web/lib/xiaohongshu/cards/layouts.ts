/**
 * 七种版式的 HTML 生成器。每个函数只产出卡片正文区（<main class="body">）的内部标记，
 * 具体长相由 template.ts 里按 style/palette 生成的 CSS 决定 —— 标记与皮肤分离，
 * 加风格不用碰这个文件，加版式不用碰 tokens。
 *
 * 版式的结构语义（几栏、几条、留白多少）照抄 baoyu-xhs-images 的
 * references/elements/canvas.md:37-123。
 */
import type { Card, CardItem, LayoutId } from "./types";

/** HTML 文本转义。卡片内容全部来自模型输出/用户编辑，一律当不可信文本处理。 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 序号徽标。numberStyle 的具体形状在 CSS 里，这里只给结构。 */
function numBadge(n: number): string {
  return `<span class="num">${n}</span>`;
}

/** 要点里的 label（如「第一步」「优点」），空则不渲染。 */
function itemLabel(item: CardItem): string {
  return item.label ? `<span class="ilabel">${esc(item.label)}</span>` : "";
}

function sparse(): string {
  // 封面/结尾：正文区完全留空，视觉重量全压在 header 的大标题上。
  // 只留一条装饰性的强调横杠，给大片留白一个视觉落点。
  return `<div class="sparse-mark"></div>`;
}

function balanced(card: Card): string {
  const rows = card.items
    .map(
      (it) => `<div class="bal-item">
      <div class="bal-dot"></div>
      <div class="bal-text">${itemLabel(it)}<span>${esc(it.text)}</span></div>
    </div>`,
    )
    .join("");
  return `<div class="bal">${rows}</div>`;
}

function dense(card: Card): string {
  const rows = card.items
    .map(
      (it, i) => `<div class="den-item" style="--zone:var(--zone${i % 4})">
      <div class="den-text">${itemLabel(it)}<span>${esc(it.text)}</span></div>
    </div>`,
    )
    .join("");
  return `<div class="den">${rows}</div>`;
}

function list(card: Card): string {
  const rows = card.items
    .map(
      (it, i) => `<div class="lst-item">
      ${numBadge(i + 1)}
      <div class="lst-text">${itemLabel(it)}<span>${esc(it.text)}</span></div>
    </div>`,
    )
    .join("");
  return `<div class="lst">${rows}</div>`;
}

function flow(card: Card): string {
  const rows = card.items
    .map((it, i) => {
      const arrow = i < card.items.length - 1 ? `<div class="flw-arrow">↓</div>` : "";
      return `<div class="flw-step" style="--zone:var(--zone${i % 4})">
      ${numBadge(i + 1)}
      <div class="flw-text">${itemLabel(it)}<span>${esc(it.text)}</span></div>
    </div>${arrow}`;
    })
    .join("");
  return `<div class="flw">${rows}</div>`;
}

function comparison(card: Card): string {
  const cols = card.groups
    .slice(0, 2)
    .map(
      (g, i) => `<div class="cmp-col" style="--zone:var(--zone${i === 0 ? 0 : 3});--zoneInk:var(--zoneInk${i === 0 ? 0 : 3})">
      <div class="cmp-head">${esc(g.heading)}</div>
      <div class="cmp-items">${g.items
        .map((t) => `<div class="cmp-item"><i></i><span>${esc(t)}</span></div>`)
        .join("")}</div>
    </div>`,
    )
    .join(`<div class="cmp-div"></div>`);
  return `<div class="cmp">${cols}</div>`;
}

function quadrant(card: Card): string {
  const cells = card.groups
    .slice(0, 4)
    .map(
      (g, i) => `<div class="qd-cell" style="--zone:var(--zone${i % 4});--zoneInk:var(--zoneInk${i % 4})">
      <div class="qd-head">${esc(g.heading)}</div>
      <div class="qd-items">${g.items
        .map((t) => `<div class="qd-item">${esc(t)}</div>`)
        .join("")}</div>
    </div>`,
    )
    .join("");
  return `<div class="qd">${cells}</div>`;
}

const BUILDERS: Record<LayoutId, (card: Card) => string> = {
  sparse: () => sparse(),
  balanced,
  dense,
  list,
  comparison,
  flow,
  quadrant,
};

/** 按版式生成卡片正文区内部 HTML。 */
export function buildLayoutHtml(card: Card): string {
  return BUILDERS[card.layout](card);
}
