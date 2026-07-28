/**
 * 组装「多图笔记」的发布 body。
 *
 * 为什么要在 web 侧自己组：本地 rednote 服务的 /long_text/auto 最后一步写死了
 * `publish_ids = [cover_fileid] + file_ids[1:]`（xhs_api.py:468-474）—— 只有第 1 张
 * 能是自备图，第 2 张起必然是小红书服务端渲染的纯文字卡。想整叠都用自己的设计卡，
 * 就得绕开它，直接打 /rednote/creator/publish（server.py:374-389 原样透传 body）。
 *
 * 结构逐字对齐 xhs_api.py 的 build_publish_body（:438-448），只有两处按需改：
 *  - width/height 如实上报每张图的真实像素（那边写死 1440×2400）
 *  - privacy_type 必须由调用方显式传入，不吃默认值（见下面的注释）
 */

import { type HashTag, type TagLike, formatTopic, tagName } from "./topics";

/** 笔记可见性。实测语义：0=公开、1=仅自己可见（rednoteApi.md / creator_api.md 两处文档都写反了）。 */
export const PRIVACY_PUBLIC = 0;
export const PRIVACY_SELF = 1;

// 与 xhs_api.py 的常量逐字节一致，改动会导致发布被拒
const SOURCE = '{"type":"web","ids":"","extraInfo":"{\\"systemId\\":\\"web\\"}"}';

/** 「声明原创」在 business_binds 里的 bind 类型（既是 type 也是 bizType）。 */
const ORIGINAL_STATEMENT = "ORIGINAL_STATEMENT";

export type BusinessBindsOptions = {
  /**
   * 声明原创的 bizId = **自己的 user_id**（rednote 的 /creator/me 取）。
   * 留空就是不声明原创（optionRelationList 为 []）。
   */
  originalUserId?: string;
  /**
   * 合集 id。⚠️ 目前用不上：长文/图文笔记（common.type="normal"）加不进 type=2 的长文合集，
   * 服务端会静默丢弃这个绑定（creator_publish_options.md §3 有三条证据链）。字段留着，等有普通合集再用。
   */
  collectionId?: string;
  /** 0 = 所有人可评论（网页版默认） */
  commentPermission?: number;
  copyable?: boolean;
  coproduce?: boolean;
};

/**
 * 组 `common.business_binds` —— 注意它是一个 **JSON 字符串**，不是对象。
 *
 * 键顺序与 rednote 的 build_business_binds()、以及网页版抓包实样逐字节一致，
 * 别改顺序也别改空对象/空数组的写法。
 */
export function buildBusinessBinds(options: BusinessBindsOptions = {}): string {
  const {
    originalUserId = "",
    collectionId = "",
    commentPermission = 0,
    copyable = true,
    coproduce = true,
  } = options;

  return JSON.stringify({
    version: 1,
    noteId: 0,
    bizType: 0,
    noteOrderBind: {},
    notePostTiming: {},
    noteCollectionBind: { id: collectionId },
    noteSketchCollectionBind: { id: "" },
    coProduceBind: { enable: coproduce },
    noteCopyBind: { copyable },
    interactionPermissionBind: { commentPermission },
    optionRelationList: originalUserId
      ? [
          {
            type: ORIGINAL_STATEMENT,
            relationList: [
              { bizType: ORIGINAL_STATEMENT, bizId: originalUserId, extraInfo: "{}" },
            ],
          },
        ]
      : [],
  });
}

/** 默认：不声明原创、不绑合集。 */
const BUSINESS_BINDS = buildBusinessBinds();

export type PublishImage = {
  fileId: string;
  width: number;
  height: number;
};

export type BuildImageNoteBodyParams = {
  title: string;
  /** 笔记正文（caption）。图片不承载全文时，完整正文放这里 */
  desc: string;
  images: PublishImage[];
  /**
   * 必传，不给默认值。build_publish_body 的 Python 默认形参是 1（仅自己可见），
   * 一旦哪里漏传就会「发布成功但没人看得见」—— 这是最难发现的一类 bug，
   * 所以这里宁可让类型强制调用方每次都写出来。
   */
  privacy: typeof PRIVACY_PUBLIC | typeof PRIVACY_SELF;
  /**
   * 已解析的真话题。顺序必须与 desc 里 `#name[话题]#` 的出现顺序**完全一致**
   * —— 直接用 buildDesc 回的 keptTags 切出来，别自己另拼一份。
   */
  hashTags?: readonly HashTag[];
  /** buildBusinessBinds() 的结果（声明原创等）。不传就是默认的「什么都不绑」。 */
  businessBinds?: string;
};

export type ImageNoteBody = {
  common: Record<string, unknown>;
  image_info: { images: Array<Record<string, unknown>> };
  video_info: null;
};

/** 拼出 /rednote/creator/publish 要的完整笔记对象。 */
export function buildImageNoteBody(params: BuildImageNoteBodyParams): ImageNoteBody {
  const images = params.images.map((img) => ({
    file_id: img.fileId,
    width: img.width,
    height: img.height,
    metadata: { source: -1 },
    stickers: { version: 2, floating: [] },
  }));

  return {
    common: {
      type: "normal",
      note_id: "",
      source: SOURCE,
      title: params.title,
      desc: params.desc,
      ats: [],
      hash_tag: (params.hashTags ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        link: t.link,
        type: "topic",
      })),
      business_binds: params.businessBinds ?? BUSINESS_BINDS,
      privacy_info: { op_type: 1, type: params.privacy, user_ids: [] },
      goods_info: { extension: { live_preheat: "0" } },
      biz_relations: [],
    },
    image_info: { images },
    video_info: null,
  };
}

/**
 * 普通图文笔记（common.type = "normal"）的 caption 长度上限，按 UTF-16 单元计。
 *
 * 注意这跟长文完全是两回事：`/creator/long_text/edit/config` 报的
 * `content_max_length: 10000` 是**长文编辑器**的额度，普通笔记远小于它。
 * 超出部分小红书会**从尾部静默截断**，而且是按字符切、不管句子完不完整。
 *
 * 1900 这个数来自实测（2026-07-26，note 6a66fb66000000001f01c82b）：
 * 发出去的笔记读回来 desc 恰好剩 1945 码点 / 1949 UTF-16 单元，断在「产业聚」三个字上，
 * 结尾的标签和 CTA 全被吃掉（读回来的 tags 字段是空数组，确认不是存到别处）。
 * 所以真实上限在 1949 附近；取 1900 留一点余量。
 * 可用 XHS_DESC_MAX_CHARS 继续微调。
 */
export const DESC_MAX_CHARS = (() => {
  const raw = Number(process.env.XHS_DESC_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1900;
})();

/**
 * 长度按 UTF-16 单元数算（JS 的 String.length），与小红书那边的口径对齐 ——
 * emoji 在这个口径下算 2，用码点数会低估、正好卡在边界上时仍会被截。
 */
function len(s: string): number {
  return s.length;
}

/** 按 UTF-16 单元数截断，但只在完整码点边界上切，绝不把一个 emoji 劈成两半。 */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * 在 max 码点以内截断，并且**只在自然边界上断**：优先断在换行处，
 * 其次断在句末标点后，都找不到才硬断。绝不把一句中文切两半。
 */
function truncateAtBoundary(text: string, max: number): string {
  if (len(text) <= max) return text;
  const head = cut(text, max);
  const nl = head.lastIndexOf("\n");
  if (nl > max * 0.5) return head.slice(0, nl).trimEnd();
  const punct = Math.max(
    ...["。", "！", "？", "；", "…", ".", "!", "?"].map((p) => head.lastIndexOf(p)),
  );
  if (punct > max * 0.5) return head.slice(0, punct + 1);
  // 省略号本身也占一个字：先少截一个再补，否则会正好超出上限 1 个字
  return `${cut(text, Math.max(0, max - 1)).trimEnd()}…`;
}

export type DescResult = {
  desc: string;
  /** 正文是否被截断 */
  truncated: boolean;
  /** 被截掉多少字（0 表示完整） */
  omitted: number;
  /** 最终 caption 长度（码点） */
  length: number;
  limit: number;
  /**
   * 实际写进 desc 的标签个数（从头数）。
   * hash_tag 必须与 desc 严格对应，所以调用方要用它切一刀：`tags.slice(0, keptTags)`。
   */
  keptTags: number;
  /** 来源署名是否写进去了（额度实在不够时会被舍弃） */
  keptSources: boolean;
};

/**
 * 把正文、来源署名与标签拼成笔记 caption，并保证在字数上限内。
 *
 * 版式（从上到下）：正文 → 来源署名 → 固定 CTA → 话题。
 * 标签一律写成 `#<name>[话题]#`（可点击话题的固定写法，见 topics.ts）；
 * 传进来的可以是标签名（前端预览手里只有名字）也可以是解析好的 HashTag，两者出的字一样长。
 *
 * 保命顺序（空间不够时先牺牲正文）：
 *  1. **标签** —— 没了就没有流量入口
 *  2. **结尾 CTA**（「评论 dd」引导）—— 没了就没有转化
 *  3. **来源署名** —— 内容可信度的凭据
 *  4. 正文 —— 从尾部按自然边界截断
 *
 * 与其让小红书从尾巴上乱砍（把 1、2、3 砍掉、正文还断在半句），不如我们自己按优先级砍。
 * ⚠️ 来源署名必须走 `sourceLines` 传进来，**不要**自己先拼到 body 末尾 ——
 * 那样它就排在正文里，一超额度就跟着正文一起被截掉（真踩过这个坑）。
 */
export function buildDesc(
  body: string,
  tags: readonly TagLike[],
  options: { limit?: number; ctaLine?: string; sourceLines?: readonly string[] } = {},
): DescResult {
  const limit = options.limit ?? DESC_MAX_CHARS;
  const names = tags.map((t) => tagName(t)).filter(Boolean);
  const sources = (options.sourceLines ?? []).map((s) => s.trim()).filter(Boolean);
  const sourceBlock = sources.join("\n");

  let text = body.trim();
  // CTA 通常已经是正文最后一句：先摘出来，免得截断时被一起砍掉
  const cta = options.ctaLine?.trim() ?? "";
  if (cta && text.endsWith(cta)) {
    text = text.slice(0, text.length - cta.length).trimEnd();
  }

  const makeTail = (count: number, withSources: boolean) => {
    const tagLine = names.slice(0, count).map(formatTopic).join(" ");
    return [withSources ? sourceBlock : "", cta, tagLine].filter(Boolean).join("\n\n");
  };

  // 尾部（来源 + CTA + 标签）自己就撑爆了额度：**整个整个地丢弃末尾的标签**，
  // 绝不按字符截断标签行 —— 半截的 `#foo[话` 既没用，又会让 hash_tag 与 desc 对不上。
  let keptSources = sourceBlock.length > 0;
  let keptTags = names.length;
  while (keptTags > 0 && len(makeTail(keptTags, keptSources)) > limit) keptTags -= 1;
  // 标签都丢光了还是放不下 → 再舍来源署名（CTA 最后才动）
  if (keptSources && len(makeTail(keptTags, true)) > limit) {
    keptSources = false;
    keptTags = names.length;
    while (keptTags > 0 && len(makeTail(keptTags, false)) > limit) keptTags -= 1;
  }

  const tail = makeTail(keptTags, keptSources);
  const tailLen = tail ? len(tail) + 2 : 0; // +2 是与正文之间的空行
  const bodyBudget = limit - tailLen;
  if (bodyBudget <= 0) {
    // 只放得下尾部，正文全舍。上面已经保证 len(tail) ≤ limit，
    // 唯一还会被硬截的情况是「一个标签都放不下、CTA 自己还超长」（此时 keptTags 已是 0）。
    const desc = truncateAtBoundary(tail, limit);
    return {
      desc,
      truncated: true,
      omitted: len(text),
      length: len(desc),
      limit,
      keptTags,
      keptSources,
    };
  }

  const kept = truncateAtBoundary(text, bodyBudget);
  const omitted = Math.max(0, len(text) - len(kept));
  const desc = [kept, tail].filter(Boolean).join("\n\n");
  return {
    desc,
    truncated: omitted > 0 || keptTags < names.length || (sources.length > 0 && !keptSources),
    omitted,
    length: len(desc),
    limit,
    keptTags,
    keptSources,
  };
}
