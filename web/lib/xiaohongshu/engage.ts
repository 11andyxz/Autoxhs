/**
 * 「小红书互动助手」共享类型与常量（客户端 / 服务端通用，勿引入服务端依赖）。
 *
 * 能力：批量为目标笔记生成「正向且相关」的评论(OpenAI) → 预览确认 → 真实发评论
 * (顺带给自己这条评论点赞) + 给帖子点赞。底层复用本地 rednote 服务的互动写接口。
 */

/** 候选笔记（来自搜索 / 信息流 / 粘贴链接）。 */
export type EngageNote = {
  id: string;
  xsecToken: string;
  title: string;
  user: string;
  liked: string;
  type: string;
  /** 是否在「已评论去重库」里（之前已成功互动过）。用于避免重复评论。 */
  commented?: boolean;
};

/** 笔记来源方式。 */
export type NoteSource = "search" | "homefeed" | "links";

/** 单批最多处理的笔记数：控制在 20，配合每篇间隔，尽量不触发小红书风控(461/限流)。 */
export const MAX_NOTES = 20;

/** 搜索 / 信息流最多翻页数（每次多翻页更容易触发风控，故收紧）。 */
export const MAX_PAGES = 3;

/** 候选列表最多展示条数（翻页可能返回很多，前端只保留这些供勾选）。 */
export const MAX_CANDIDATES = 60;

/** 每篇之间的间隔秒数：写操作有真实副作用且高频会被风控，故串行 + 间隔。 */
export const MIN_DELAY_SEC = 2;
export const MAX_DELAY_SEC = 15;
export const DEFAULT_DELAY_SEC = 4;

/** 操作者可选的「评论风格/额外说明」长度上限。 */
export const MAX_STYLE_HINT = 200;

/** 单条评论文本长度上限（小红书评论偏短；超出视为异常，客户端 textarea 也据此限长）。 */
export const MAX_COMMENT_CHARS = 100;
