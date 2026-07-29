/**
 * 「内容角度」轮换：同一个题材连着发 24 篇，最怕的是 24 篇一个腔调、一个长相。
 *
 * 根因是两处会塌缩：
 *  1) 改写提示词偏好痛点/避坑型标题，而我们又永远取 titles[0] → 每篇都是「别 xxx」；
 *  2) 拆卡提示词按内容气质选风格，而「避坑/警示 → bold」，bold 自带黄底红块 → 每篇都一个样。
 *
 * 所以这里不让模型自由选：**按整点轮换角度，角度同时决定「怎么写」和「长什么样」**。
 * 角度由「日期 + 整点」算出，不存状态、不多花 AI 调用，且同一天相邻整点必然不同角度、
 * 同一个钟点隔天也会换。
 *
 * 现成有 6 风格 × 4 配色 = 24 个组合，之前只用到 bold+default 一个。这里先把已有的用起来，
 * 而不是新写风格 —— 真要扩，等看过哪几组顺眼再挑。
 */

import type { PaletteId, StyleId } from "@/lib/xiaohongshu/cards/types";

export type Angle = {
  id: string;
  /** 日志里好认 */
  label: string;
  /** 追加给改写模型的写作指令（这一篇要用什么讲法） */
  brief: string;
  /** 从模型给的 8 个标题里，优先挑 style 标签命中这些关键词的 */
  titlePrefer: string[];
  /**
   * 封面角标。必须显式给，否则拆卡模型会一律写「避坑」——
   * 信息流里读者第一眼看的就是封面，那一处最容易把整个账号拖回警示腔。
   */
  badge: string;
  style: StyleId;
  palette: PaletteId;
};

/**
 * 只有 pitfall 保留原来的「避坑警示 + 黄底」，占 1/8。
 * 刻意不用 cute（少女甜心/粉色）—— 与这个账号讲移民规则的调性不搭。
 */
export const ANGLES: Angle[] = [
  {
    id: "timeline",
    label: "时间线",
    brief:
      "用**时间线**讲：按时间先后把关键节点串起来（什么时候能做什么、各步之间隔多久、哪个日期决定后面所有事）。" +
      "读者读完应该能照着排出自己的日程表。",
    titlePrefer: ["时间", "流程", "步骤", "干货"],
    badge: "干货",
    style: "notion",
    palette: "default",
  },
  {
    id: "explainer",
    label: "概念科普",
    brief:
      "用**科普解释**讲：把这个概念/机制本身讲透 —— 它是什么、为什么这样设计、谁说了算、和相邻的概念什么关系。" +
      "语气像在给朋友讲清一件复杂的事，不是在警告他。",
    titlePrefer: ["疑问", "科普", "信息差", "干货"],
    badge: "科普",
    style: "minimal",
    palette: "default",
  },
  {
    id: "comparison",
    label: "对比辨析",
    brief:
      "用**对比**讲：把最容易被混为一谈的两件事（或两种情形）并排放，逐条说清差在哪、各自适用谁。" +
      "结构上要能明显看出「这边 / 那边」。",
    titlePrefer: ["信息差", "对比", "疑问", "区别"],
    badge: "对比",
    style: "chalkboard",
    palette: "default",
  },
  {
    id: "checklist",
    label: "清单自查",
    brief:
      "用**自查清单**讲：给出可以逐项打勾的条目，每条都是读者能立刻对照自己情况判断的具体项。" +
      "不要写成注意事项大杂烩，要能真的一条条过。",
    titlePrefer: ["清单", "干货", "收藏", "自查"],
    badge: "清单",
    style: "notion",
    palette: "macaron",
  },
  {
    id: "case",
    label: "案例复盘",
    brief:
      "用**一个具体情境**讲：设定一个典型情况（时间、身份状态、手上有什么材料），把它从头走到尾，" +
      "过程中在哪些岔路口需要做判断。不要点名真人真事，用「假设你现在…」的方式。",
    titlePrefer: ["场景", "案例", "故事", "经历"],
    badge: "案例",
    style: "warm",
    palette: "default",
  },
  {
    id: "facts",
    label: "数字速查",
    brief:
      "用**关键数字速查**讲：把这件事里所有硬性数字集中讲清（天数、期限、次数、金额、表格版本），" +
      "每个数字都要带上「从哪天起算 / 谁适用」。读者是拿来查的，不是读故事的。",
    titlePrefer: ["数字", "干货", "结果", "速查"],
    badge: "速查",
    style: "bold",
    palette: "macaron",
  },
  {
    id: "myth",
    label: "误解纠正",
    brief:
      "用**纠正常见误解**讲：先说清「很多人以为是这样」，再说「官方规则其实是那样」，" +
      "重点在把误解的来源讲明白（为什么大家会这么想），而不是嘲讽读者不懂。",
    titlePrefer: ["信息差", "误区", "反差", "疑问"],
    badge: "误区",
    style: "bold",
    palette: "neon",
  },
  {
    id: "pitfall",
    label: "避坑警示",
    brief:
      "用**避坑警示**讲：点出最容易踩错的地方、踩错的实际代价、以及怎么提前避开。" +
      "这是本账号原有的讲法，保持原样。",
    titlePrefer: ["避坑", "风险", "提醒", "痛点"],
    badge: "避坑",
    style: "bold",
    palette: "default",
  },
];

/** 除了「避坑警示」，其余角度都要压住命令式警告腔，否则模型会习惯性写回「别 xxx」。 */
const NO_SCOLDING =
  "另外：标题和开头**不要**用「别…」「千万不要」「先别」「小心」这类命令式警告，" +
  "也不要靠制造恐慌开场。用陈述、疑问或时间线的方式起头，专业感靠把规则讲清楚来体现。";

/** 日期字符串 → 稳定的整数种子（同一天恒定，隔天变化）。 */
function dateSeed(date: string): number {
  let sum = 0;
  for (let i = 0; i < date.length; i += 1) sum = (sum * 31 + date.charCodeAt(i)) % 100003;
  return sum;
}

/**
 * 这个整点该用哪个角度。
 * `(种子 + 整点) % 角度数` —— 相邻整点必然不同角度；同一个钟点隔天也会换一个。
 */
export function pickAngle(date: string, slot: number): Angle {
  const idx = (dateSeed(date) + slot) % ANGLES.length;
  return ANGLES[idx];
}

/** 追加进「参考资料」里的写作指令。 */
export function angleInstruction(angle: Angle): string {
  const parts = [`本篇的讲法：${angle.brief}`];
  if (angle.id !== "pitfall") parts.push(NO_SCOLDING);
  return parts.join("\n");
}

/**
 * 追加给**拆卡**模型的要求。
 *
 * 必须单独给一份：拆卡只拿到标题和正文，它会自己另写封面标题、自己决定 badge，
 * 于是即便正文已经是清单口吻，封面照样写成「先别急着…」+「避坑」——
 * 而信息流里读者看到的恰恰只有封面。实测就栽在这里。
 */
export function angleOutlineHint(angle: Angle): string {
  const parts = [
    `本篇的讲法是「${angle.label}」，封面与各卡的标题都要贴着这个讲法`,
    `封面 badge 必须用「${angle.badge}」，不要自己换成别的词`,
  ];
  if (angle.id !== "pitfall") {
    parts.push(
      "封面标题不要用「别…」「先别」「千万不要」「小心」这类命令式警告，也不要靠制造恐慌吸引点击；" +
        "用陈述、疑问或「A 和 B 的区别」这类写法",
    );
  }
  return parts.join("；");
}

export type TitleCandidate = { text: string; style: string };

/**
 * 按角度挑标题：优先取 style 标签命中 titlePrefer 的那个。
 *
 * 模型本来就会输出 8 个带风格标签的标题（避坑型/疑问型/干货型/信息差型/场景型…），
 * 一直取 titles[0] 才是「每篇都像避坑文」的直接原因 —— 提示词里就写着优先给痛点/避坑型。
 * 命中不了就退回第一个（有标题总比没有好）。
 */
export function pickTitle(titles: readonly TitleCandidate[], angle: Angle): string {
  const usable = titles.filter((t) => t?.text?.trim());
  if (usable.length === 0) return "";
  const hit = usable.find((t) =>
    angle.titlePrefer.some((k) => (t.style ?? "").includes(k) || t.text.includes(k)),
  );
  return (hit ?? usable[0]).text.trim();
}
