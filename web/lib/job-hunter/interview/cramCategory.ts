/**
 * 「对应简历猛攻版」复习卡的**来源分类**(纯逻辑,好被单测覆盖)。
 *
 * 卡片进队列的路子有六条,混在一个队列里复习时分不清「这张是我自己追问追出来的」还是
 * 「外部题库导进来的」。分类就是给每张卡打上来源标签,好按类挑着复习。
 *
 * 分类口径:
 * - word / svg 由 `kind` 决定(它们的渲染方式就不一样,改分类会和渲染打架),不可手改;
 * - block 卡由 `ip_cram_card.source` 决定(ask / import / note / coding),可以手改。
 *
 * `source` 列是后加的:历史卡片全是 NULL,由 `guessLegacyCramSource()` 一次性回填
 * (见 cram.ts 的 backfillCramSources)。新卡由各写入口显式带上 source。
 */

/** 分类键。数组顺序 = 界面上分类筛选条的顺序。 */
export const CRAM_CATEGORIES = ["ask", "import", "word", "note", "coding", "svg"] as const;
export type CramCategory = (typeof CRAM_CATEGORIES)[number];

/** 能手动改的分类:只有 block 卡这几种(word/svg 由 kind 定死)。 */
export const CRAM_BLOCK_CATEGORIES = ["ask", "import", "note", "coding"] as const;
export type CramBlockCategory = (typeof CRAM_BLOCK_CATEGORIES)[number];

export const CRAM_CATEGORY_META: Record<CramCategory, { icon: string; label: string; hint: string }> = {
  ask: { icon: "💬", label: "追问", hint: "读材料时追问，把答案存成的卡" },
  import: { icon: "📥", label: "题库导入", hint: "从外部题库（Excel）批量导进来的问答题" },
  word: { icon: "🔤", label: "单词", hint: "阅读区划词加入的单词卡" },
  note: { icon: "🧠", label: "划词知识块", hint: "阅读区划一段直接加入的要点（没有题面）" },
  coding: { icon: "⌨️", label: "Coding 题", hint: "从 Coding 跟打训练转过来的题" },
  svg: { icon: "📊", label: "记忆图卡", hint: "选一大段生成的 SVG 图卡" },
};

/** 追问卡的正面标记:`选中的原文\n\n❓ 我的问题`(见 page.tsx 的 saveAsBlock)。 */
export const ASK_MARK = "❓";

/**
 * 同一秒里插进来这么多张(含)以上 = 批量导入。
 * 单张加卡(划词/追问/Coding)每张都要等一次 AI 往返,不可能一秒攒够 5 张;
 * 而 addCramCardsBulk 是一条 INSERT 多行,整批共用同一个 NOW()。
 */
export const BULK_CLUSTER_MIN = 5;

export function isCramCategory(v: unknown): v is CramCategory {
  return typeof v === "string" && (CRAM_CATEGORIES as readonly string[]).includes(v);
}

export function isCramBlockCategory(v: unknown): v is CramBlockCategory {
  return typeof v === "string" && (CRAM_BLOCK_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 一张卡属于哪一类。kind 优先(word/svg),其余看 source;
 * source 缺失时(理论上回填后不会有)按正面形态兜底,不至于露出空标签。
 */
export function cramCategory(card: { kind: string; source?: string | null; front?: string | null }): CramCategory {
  if (card.kind === "word") return "word";
  if (card.kind === "svg") return "svg";
  if (isCramBlockCategory(card.source)) return card.source;
  const front = (card.front ?? "").trim();
  if (front.includes(ASK_MARK)) return "ask";
  return front ? "import" : "note";
}

/** 新卡没显式指定来源时的默认值(按 kind 兜底)。 */
export function defaultCramSource(kind: string): CramCategory {
  if (kind === "word") return "word";
  if (kind === "svg") return "svg";
  return "note"; // block 卡默认按「划词知识块」算,各写入口都会显式覆盖
}

/**
 * 历史卡片(source IS NULL)的来源推断。只用这几个信号,故意不看正文:
 * - kind:word/svg 一锤定音;
 * - extra_json 里的 `"source":"coding"`:Coding 跟打转过来的卡本来就写了这个;
 * - 正面含 ❓:追问存卡时拼的标记;
 * - 没有正面:划词直接加入的知识块(只有正文);
 * - 同一秒的兄弟数量:≥ BULK_CLUSTER_MIN 说明是一条 INSERT 批量写进来的 → 题库导入。
 *
 * 剩下的「有正面、不是批量」= 追问时没选中原文(front 只有问题本身)。
 */
export function guessLegacyCramSource(row: {
  kind: string;
  /** 正面文字里含 ❓ */
  hasQuestionMark: boolean;
  /** 正面非空(去掉空白后) */
  hasFront: boolean;
  /** extra_json 标了 coding 来源 */
  isCoding: boolean;
  /** 同一 session、同一 created_at 秒内的卡片张数(含自己) */
  sameSecondCount: number;
}): CramCategory {
  if (row.kind === "word") return "word";
  if (row.kind === "svg") return "svg";
  if (row.isCoding) return "coding";
  if (row.hasQuestionMark) return "ask";
  if (!row.hasFront) return "note";
  return row.sameSecondCount >= BULK_CLUSTER_MIN ? "import" : "ask";
}
