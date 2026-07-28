/**
 * 话题（标签）——「可点击话题」不是在正文里写个 `#xxx` 就有的。
 *
 * 实证结论见 Js-Reverse/sites/rednote/docs/creator_publish_options.md §2：发布 body 里必须**双写**
 *  - `common.desc`     写成 `#<name>[话题]#`，标签之间一个空格
 *  - `common.hash_tag` 放 `{id, name, link, type:"topic"}`，顺序与 desc 中出现顺序**一一对应**
 *
 * 只写 desc 不写 hash_tag（本项目改造前的老行为）→ 标签只是普通文字，不可点、没有流量入口。
 *
 * `id` 与 `link` 都**无法本地构造**（link 里的那个 id 是话题页 id，和话题 id 不是一回事，
 * 两者不能互相推导），只能从话题搜索接口原样透传 —— 见 rednote.ts 的 resolveTopics()。
 */

/** 发布 body 里 `common.hash_tag[]` 的一个元素。字段必须原样透传，不能自己拼。 */
export type HashTag = {
  id: string;
  name: string;
  link: string;
  type: "topic";
};

/** 标签名或已解析好的话题 —— 前端预览手里只有名字，发布路由手里是解析后的话题。 */
export type TagLike = string | HashTag;

/** 取标签名：`#北美求职` 与 HashTag 都归一到 `北美求职`。 */
export function tagName(tag: TagLike): string {
  return typeof tag === "string" ? normalizeTagName(tag) : normalizeTagName(tag.name);
}

/**
 * 规整标签名：去掉前导 `#`、去掉首尾空白。
 * 话题名要拿去做**精确同名匹配**，所以中间的空格保留原样（有些话题名本身带空格）。
 */
export function normalizeTagName(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
}

/** 规整一组标签名：去空、去重（忽略大小写），保持原顺序。 */
export function normalizeTagNames(tags: readonly TagLike[] | undefined | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    const name = tagName(tag);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** desc 里的话题写法，格式固定（与网页版抓包实样逐字一致）。 */
export function formatTopic(name: string): string {
  return `#${name}[话题]#`;
}

/** 一串话题拼成 desc 里的标签行：`#a[话题]# #b[话题]#`。 */
export function topicLine(tags: readonly TagLike[]): string {
  return tags
    .map((t) => tagName(t))
    .filter(Boolean)
    .map(formatTopic)
    .join(" ");
}
