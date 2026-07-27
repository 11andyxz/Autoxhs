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

/** 笔记可见性。实测语义：0=公开、1=仅自己可见（rednoteApi.md / creator_api.md 两处文档都写反了）。 */
export const PRIVACY_PUBLIC = 0;
export const PRIVACY_SELF = 1;

// 与 xhs_api.py:386-390 的两个常量逐字节一致，改动会导致发布被拒
const SOURCE = '{"type":"web","ids":"","extraInfo":"{\\"systemId\\":\\"web\\"}"}';
const BUSINESS_BINDS =
  '{"version":1,"noteId":0,"bizType":0,"noteOrderBind":{},"notePostTiming":{},' +
  '"noteCollectionBind":{"id":""},"noteSketchCollectionBind":{"id":""},' +
  '"coProduceBind":{"enable":true},"noteCopyBind":{"copyable":true},' +
  '"interactionPermissionBind":{"commentPermission":0},"optionRelationList":[]}';

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
      hash_tag: [],
      business_binds: BUSINESS_BINDS,
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
};

/**
 * 把正文与标签拼成笔记 caption，并保证在字数上限内。
 *
 * 保命顺序（空间不够时先牺牲正文）：
 *  1. **标签** —— 没了就没有流量入口
 *  2. **结尾 CTA**（正文最后一句的「评论 dd」引导）—— 没了就没有转化
 *  3. 正文 —— 从尾部按自然边界截断
 *
 * 与其让小红书从尾巴上乱砍（把 1、2 砍掉、正文还断在半句），不如我们自己按优先级砍。
 * ctaLine 传入正文里那句固定引导语（lib/schema 的 CTA_LINE），会被挪到标签之前保留。
 */
export function buildDesc(
  body: string,
  tags: string[],
  options: { limit?: number; ctaLine?: string } = {},
): DescResult {
  const limit = options.limit ?? DESC_MAX_CHARS;
  const tagLine = tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");

  let text = body.trim();
  // CTA 通常已经是正文最后一句：先摘出来，免得截断时被一起砍掉
  const cta = options.ctaLine?.trim() ?? "";
  if (cta && text.endsWith(cta)) {
    text = text.slice(0, text.length - cta.length).trimEnd();
  }

  const tail = [cta, tagLine].filter(Boolean).join("\n\n");
  // 尾部（CTA + 标签）本身就超预算：只能保尾部，正文全舍
  const tailLen = tail ? len(tail) + 2 : 0; // +2 是与正文之间的空行
  const bodyBudget = limit - tailLen;
  if (bodyBudget <= 0) {
    const desc = truncateAtBoundary(tail, limit);
    return { desc, truncated: true, omitted: len(text), length: len(desc), limit };
  }

  const kept = truncateAtBoundary(text, bodyBudget);
  const omitted = Math.max(0, len(text) - len(kept));
  const desc = [kept, tail].filter(Boolean).join("\n\n");
  return { desc, truncated: omitted > 0, omitted, length: len(desc), limit };
}
