/**
 * 设计 token：风格(style) × 配色(palette) × 版式(layout) 三张纯数据表。
 *
 * 色值与版式参数来自 baoyu-xhs-images skill 的 references/presets/*.md、
 * references/palettes/*.md、references/elements/canvas.md（该 skill 是 markdown
 * 设计手册，这里是一次性转写，不是运行时依赖）。
 *
 * 这个文件是纯数据，加风格 / 加配色都是 append-only 的零风险扩展。
 */
import type { LayoutId, PaletteId, StyleId } from "./types";

// ---- 配色 ----

export type Palette = {
  name: string;
  /** 整卡背景 */
  bg: string;
  /** 内容块（卡中卡）背景 */
  surface: string;
  /** 正文主色 */
  ink: string;
  /** 次要文字 */
  sub: string;
  /** 分隔线 / 边框 */
  line: string;
  /** 强调色：序号、下划线、高亮 */
  accent: string;
  /** 分区轮转色，dense / quadrant / flow 逐条取用 */
  zones: string[];
};

/**
 * `default` 是占位：实际取风格自带的 palette（见 resolvePalette）。
 * 其余三套照抄 baoyu palettes/*.md 的 hex 值。
 */
export const PALETTES: Record<Exclude<PaletteId, "default">, Palette> = {
  macaron: {
    name: "马卡龙",
    bg: "#F5F0E8",
    surface: "#FFFFFF",
    ink: "#2E2A26",
    sub: "#6B635B",
    line: "#E0D8CC",
    accent: "#E8655A",
    zones: ["#A8D8EA", "#D5C6E0", "#B5E5CF", "#F8D5C4"],
  },
  warm: {
    name: "暖砂",
    bg: "#FFECD2",
    surface: "#FFF8EF",
    ink: "#4A2C17",
    sub: "#8A6248",
    line: "#EBD3B4",
    accent: "#A0522D",
    zones: ["#ED8936", "#C05621", "#F6AD55", "#D4A09A"],
  },
  neon: {
    name: "霓虹",
    bg: "#1A1025",
    surface: "#251633",
    ink: "#F5F0FF",
    sub: "#B9A8CE",
    line: "#3D2A52",
    accent: "#FFFF00",
    zones: ["#00F5FF", "#FF00FF", "#39FF14", "#FF6EC7"],
  },
};

// ---- 风格 ----

/** 底纹：整卡背景上叠的图案，用 CSS 渐变实现，无外部资源。 */
export type BgPattern = "none" | "grid" | "dots" | "paper" | "chalk";
/** 标题强调形状：给标题里的关键部分或标题整体加的装饰。 */
export type AccentShape = "underline" | "highlight" | "block" | "none";
/** 序号样式（list / flow 用）。 */
export type NumberStyle = "circle" | "square" | "plain";

export type Style = {
  name: string;
  /** 该风格自带的配色（palette 选 default 时用它） */
  palette: Palette;
  /** 标题是否用得意黑（斜体展示字，冲击力强）；false 则用 Noto Sans SC Bold */
  displayTitle: boolean;
  titleTracking: string;
  /** 卡片圆角 */
  radius: number;
  /** 内容块描边；null 表示不描边 */
  border: string | null;
  /** 内容块投影；null 表示不投影 */
  shadow: string | null;
  bgPattern: BgPattern;
  accentShape: AccentShape;
  numberStyle: NumberStyle;
  /** 内容块之间的间距（CSS px，逻辑像素） */
  gap: number;
};

const NOTION_PALETTE: Palette = {
  name: "notion",
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  ink: "#1A1A1A",
  sub: "#4A4A4A",
  line: "#E4E4E4",
  accent: "#1A1A1A",
  zones: ["#A8D4F0", "#F9E79F", "#FADBD8", "#D5E8D4"],
};

const CUTE_PALETTE: Palette = {
  name: "cute",
  bg: "#FFF1F4",
  surface: "#FFFFFF",
  ink: "#3D2530",
  sub: "#8A6675",
  line: "#FFD9E2",
  accent: "#FF5C8A",
  zones: ["#FFB3C9", "#FFD5B8", "#C9E4FF", "#E2D1FF"],
};

const BOLD_PALETTE: Palette = {
  name: "bold",
  bg: "#FFE500",
  surface: "#FFFFFF",
  ink: "#111111",
  sub: "#3A3A3A",
  line: "#111111",
  accent: "#FF2E51",
  zones: ["#FF2E51", "#111111", "#0066FF", "#00C16E"],
};

const WARM_PALETTE: Palette = {
  name: "warm",
  bg: "#FFF3E6",
  surface: "#FFFDFA",
  ink: "#4A3428",
  sub: "#8A705C",
  line: "#F0DCC6",
  accent: "#D2691E",
  zones: ["#E8A87C", "#C38D9E", "#E4B363", "#A7C4BC"],
};

const MINIMAL_PALETTE: Palette = {
  name: "minimal",
  bg: "#FFFFFF",
  surface: "#F7F7F7",
  ink: "#141414",
  sub: "#767676",
  line: "#E8E8E8",
  accent: "#141414",
  zones: ["#141414", "#767676", "#B0B0B0", "#DCDCDC"],
};

const CHALK_PALETTE: Palette = {
  name: "chalkboard",
  bg: "#20302B",
  surface: "#2A3D36",
  ink: "#F4F1E8",
  sub: "#B9C7BF",
  line: "#41564D",
  accent: "#FFE066",
  zones: ["#FFE066", "#8FD9A8", "#93C5FD", "#F9A8A8"],
};

export const STYLES: Record<StyleId, Style> = {
  notion: {
    name: "极简手记",
    palette: NOTION_PALETTE,
    displayTitle: false,
    titleTracking: "-0.5px",
    radius: 14,
    border: "2px solid #1A1A1A",
    shadow: null,
    bgPattern: "none",
    accentShape: "underline",
    numberStyle: "square",
    gap: 18,
  },
  cute: {
    name: "少女甜心",
    palette: CUTE_PALETTE,
    displayTitle: true,
    titleTracking: "0px",
    radius: 28,
    border: null,
    shadow: "0 8px 24px rgba(255,92,138,.14)",
    bgPattern: "dots",
    accentShape: "highlight",
    numberStyle: "circle",
    gap: 20,
  },
  bold: {
    name: "高冲击",
    palette: BOLD_PALETTE,
    displayTitle: true,
    titleTracking: "-1px",
    radius: 6,
    border: "4px solid #111111",
    shadow: "8px 8px 0 #111111",
    bgPattern: "none",
    accentShape: "block",
    numberStyle: "square",
    gap: 22,
  },
  warm: {
    name: "温暖生活",
    palette: WARM_PALETTE,
    displayTitle: false,
    titleTracking: "0px",
    radius: 22,
    border: null,
    shadow: "0 6px 20px rgba(74,52,40,.10)",
    bgPattern: "paper",
    accentShape: "underline",
    numberStyle: "circle",
    gap: 18,
  },
  minimal: {
    name: "克制专业",
    palette: MINIMAL_PALETTE,
    displayTitle: false,
    titleTracking: "-0.5px",
    radius: 0,
    border: null,
    shadow: null,
    bgPattern: "none",
    accentShape: "none",
    numberStyle: "plain",
    gap: 26,
  },
  chalkboard: {
    name: "黑板课堂",
    palette: CHALK_PALETTE,
    displayTitle: true,
    titleTracking: "0px",
    radius: 12,
    border: "2px dashed #41564D",
    shadow: null,
    bgPattern: "chalk",
    accentShape: "underline",
    numberStyle: "circle",
    gap: 18,
  },
};

/** palette 选 default 时回落到风格自带配色；否则用覆盖配色（渲染规则不变）。 */
export function resolvePalette(style: StyleId, palette: PaletteId): Palette {
  if (palette === "default") return STYLES[style].palette;
  return PALETTES[palette];
}

// ---- 版式 ----

export type LayoutMeta = {
  name: string;
  /** 该版式期望的要点条数 [最少, 最多]；不满足时 outline 层会调整 */
  items: [number, number];
  /** 需要的分组数；0 表示不用 groups */
  groups: number;
  /** 说明，进 LLM 提示词 */
  hint: string;
};

/** 留白比例与结构语义照抄 baoyu references/elements/canvas.md:37-55。 */
export const LAYOUT_META: Record<LayoutId, LayoutMeta> = {
  sparse: {
    name: "留白",
    items: [0, 2],
    groups: 0,
    hint: "留白 60-70%，只放 1 句核心主张。用于封面和结尾。",
  },
  balanced: {
    name: "均衡",
    items: [3, 4],
    groups: 0,
    hint: "留白 40-50%，标题 + 3~4 个要点，标准内容页。",
  },
  dense: {
    name: "密集",
    items: [5, 8],
    groups: 0,
    hint: "留白 20-30%，5~8 个要点的知识卡 / 速查表。",
  },
  list: {
    name: "清单",
    items: [4, 7],
    groups: 0,
    hint: "带序号的竖排枚举，4~7 条。用于排行、清单、步骤。",
  },
  comparison: {
    name: "对比",
    items: [0, 0],
    groups: 2,
    hint: "左右两栏对照，正好 2 组。用于前后对比、优缺点。",
  },
  flow: {
    name: "流程",
    items: [3, 6],
    groups: 0,
    hint: "自上而下带箭头的流程，3~6 步。用于教程、时间线。",
  },
  quadrant: {
    name: "四象限",
    items: [0, 0],
    groups: 4,
    hint: "2×2 四格，正好 4 组。用于 SWOT、分类、优先级矩阵。",
  },
};

/** 风格 × 版式兼容矩阵（照抄 SKILL.md 的 Style × Layout Matrix，取「不推荐」的组合）。 */
const POOR_MATCH: Partial<Record<StyleId, LayoutId[]>> = {
  minimal: ["quadrant"],
  chalkboard: ["comparison"],
};

/** 该组合是否不推荐 —— UI 上给个提示，不阻止。 */
export function isPoorMatch(style: StyleId, layout: LayoutId): boolean {
  return (POOR_MATCH[style] ?? []).includes(layout);
}

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];
export const LAYOUT_IDS = Object.keys(LAYOUT_META) as LayoutId[];
export const PALETTE_IDS: PaletteId[] = ["default", "macaron", "warm", "neon"];
