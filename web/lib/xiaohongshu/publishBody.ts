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
 * 把正文与标签拼成笔记 caption。
 * 标签跟在正文后面单独一行 —— 与现有长文发布保持一致的观感（那边 desc 只有标签）。
 */
export function buildDesc(body: string, tags: string[]): string {
  const text = body.trim();
  const tagLine = tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");
  if (!tagLine) return text;
  return text ? `${text}\n\n${tagLine}` : tagLine;
}
