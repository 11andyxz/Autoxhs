/**
 * 小红书「设计卡片」的数据模型。
 *
 * 一叠卡片(deck) = 1 张封面 + N 张内容卡 + 1 张结尾卡，全部由本地 HTML/CSS 渲染、
 * 本机 Chrome 截图成 PNG，不经过任何生图模型 —— 中文永远不会糊、不会错字，
 * 同一份 outline 渲染两次得到同一张图。
 *
 * style / layout / palette 三个维度的取值与设计规格来自 JimLiu/baoyu-skills 的
 * baoyu-xhs-images skill（SIL 风格规范部分：每个 preset 的 hex 色值、各 layout 的
 * 留白比例与结构语义、画布安全区）。那是一份 markdown 设计手册，此处把其中的参数
 * 转写成 CSS token —— 不存在任何运行时依赖。
 */

/** 卡片在整叠里的位置角色。封面负责钩子，结尾负责 CTA。 */
export type CardKind = "cover" | "content" | "ending";

/** 版式。留白比例与结构语义见 tokens.ts 的 LAYOUT_META。 */
export type LayoutId =
  | "sparse"
  | "balanced"
  | "dense"
  | "list"
  | "comparison"
  | "flow"
  | "quadrant";

/** 视觉风格。决定字体、描边、底纹、强调形状。 */
export type StyleId = "notion" | "cute" | "bold" | "warm" | "minimal" | "chalkboard";

/** 配色。覆盖风格自带的颜色，但不改渲染规则（描边/底纹照旧）。 */
export type PaletteId = "default" | "macaron" | "warm" | "neon";

/** 一个要点条目。label 是序号旁的短词（如「第一步」「优点」），可为空。 */
export type CardItem = {
  label: string | null;
  text: string;
};

/** 一个分组，用于 comparison(2 组) / quadrant(4 组)。 */
export type CardGroup = {
  heading: string;
  items: string[];
};

/**
 * 单张卡的内容。字段是「所有版式的并集」，各版式各取所需：
 * - sparse   : title + subtitle
 * - balanced : title + subtitle + items(3~4)
 * - dense    : title + items(5~8)
 * - list     : title + items(4~7，带序号)
 * - flow     : title + items(3~6，带箭头)
 * - comparison: title + groups(正好 2)
 * - quadrant : title + groups(正好 4)
 */
export type Card = {
  kind: CardKind;
  layout: LayoutId;
  title: string;
  subtitle: string | null;
  /** 右上角小角标，如「干货」「1/6」。留空不渲染。 */
  badge: string | null;
  items: CardItem[];
  groups: CardGroup[];
};

/** 一整叠卡片的完整描述 —— 可持久化、可人工编辑、可单张重渲。 */
export type CardOutline = {
  /** 整叠的主题（用于文件名与日志，不上图） */
  topic: string;
  style: StyleId;
  palette: PaletteId;
  /** 右下角水印，通常是账号名。留空不渲染。 */
  watermark: string | null;
  cards: Card[];
};

/** 渲染产物尺寸。3:4 是小红书信息流流量最高的比例（baoyu canvas.md）。 */
export const CARD_WIDTH = 1440;
export const CARD_HEIGHT = 1920;
/** CSS 逻辑像素尺寸；截图时 deviceScaleFactor=2 放大到上面的物理尺寸。 */
export const CSS_WIDTH = CARD_WIDTH / 2;
export const CSS_HEIGHT = CARD_HEIGHT / 2;

/** 一叠卡片的张数上下限。上限 10 是自设的保守值（小红书真实上限未验证）。 */
export const MIN_CARDS = 3;
export const MAX_CARDS = 10;

/**
 * 渲染器接口。当前只有 HTML 实现；若将来要加「AI 生图」实现，
 * 让它满足同一个接口即可，上层（路由、UI、发布管道）不需要改。
 */
export type CardRenderer = {
  /** 渲染整叠；only 传下标时只渲染那一张（返回长度为 1 的数组）。 */
  render(outline: CardOutline, only?: number): Promise<Buffer[]>;
};
