import { describe, expect, it } from "vitest";

import {
  PRIVACY_PUBLIC,
  PRIVACY_SELF,
  buildBusinessBinds,
  buildDesc,
  buildImageNoteBody,
} from "./publishBody";
import type { HashTag } from "./topics";

const IMAGES = [
  { fileId: "a1", width: 1440, height: 1920 },
  { fileId: "b2", width: 1440, height: 1920 },
];

const topic = (name: string, id = `id-${name}`): HashTag => ({
  id,
  name,
  link: `https://www.xiaohongshu.com/page/topics/p-${name}?naviHidden=yes`,
  type: "topic",
});

describe("buildImageNoteBody", () => {
  it("按顺序放入全部图片，不做任何裁剪", () => {
    const body = buildImageNoteBody({
      title: "标题",
      desc: "正文",
      images: IMAGES,
      privacy: PRIVACY_PUBLIC,
    });
    expect(body.image_info.images).toHaveLength(2);
    expect(body.image_info.images.map((i) => i.file_id)).toEqual(["a1", "b2"]);
  });

  it("如实上报每张图的真实像素（不写死 1440×2400）", () => {
    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: [{ fileId: "x", width: 1242, height: 1660 }],
      privacy: PRIVACY_PUBLIC,
    });
    expect(body.image_info.images[0]).toMatchObject({ width: 1242, height: 1660 });
  });

  it("privacy 原样写进 privacy_info.type：0=公开", () => {
    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: IMAGES,
      privacy: PRIVACY_PUBLIC,
    });
    expect(body.common.privacy_info).toEqual({ op_type: 1, type: 0, user_ids: [] });
  });

  it("privacy=1 是仅自己可见", () => {
    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: IMAGES,
      privacy: PRIVACY_SELF,
    });
    expect(body.common.privacy_info).toMatchObject({ type: 1 });
  });

  it("source 与 business_binds 与 rednote 侧常量逐字一致", () => {
    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: IMAGES,
      privacy: PRIVACY_PUBLIC,
    });
    // 这两个串一旦漂移，小红书会拒绝发布；用字面量钉死，改动必须先改测试
    expect(body.common.source).toBe(
      '{"type":"web","ids":"","extraInfo":"{\\"systemId\\":\\"web\\"}"}',
    );
    expect(body.common.business_binds).toBe(
      '{"version":1,"noteId":0,"bizType":0,"noteOrderBind":{},"notePostTiming":{},' +
        '"noteCollectionBind":{"id":""},"noteSketchCollectionBind":{"id":""},' +
        '"coProduceBind":{"enable":true},"noteCopyBind":{"copyable":true},' +
        '"interactionPermissionBind":{"commentPermission":0},"optionRelationList":[]}',
    );
  });

  it("默认不带话题；给了 hashTags 就按顺序原样写进 hash_tag", () => {
    const tags = [topic("OPT", "5d93"), topic("留学生找工作", "6173")];
    expect(
      buildImageNoteBody({ title: "t", desc: "d", images: IMAGES, privacy: PRIVACY_PUBLIC })
        .common.hash_tag,
    ).toEqual([]);

    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: IMAGES,
      privacy: PRIVACY_PUBLIC,
      hashTags: tags,
    });
    expect(body.common.hash_tag).toEqual([
      { id: "5d93", name: "OPT", link: tags[0].link, type: "topic" },
      { id: "6173", name: "留学生找工作", link: tags[1].link, type: "topic" },
    ]);
  });

  it("图文笔记不带视频信息", () => {
    const body = buildImageNoteBody({
      title: "t",
      desc: "d",
      images: IMAGES,
      privacy: PRIVACY_PUBLIC,
    });
    expect(body.video_info).toBeNull();
  });
});

describe("buildBusinessBinds", () => {
  it("声明原创 = optionRelationList 里放一条 ORIGINAL_STATEMENT，bizId 是自己的 user_id", () => {
    const binds = JSON.parse(buildBusinessBinds({ originalUserId: "66ba3e71000000001d030729" }));
    expect(binds.optionRelationList).toEqual([
      {
        type: "ORIGINAL_STATEMENT",
        relationList: [
          {
            bizType: "ORIGINAL_STATEMENT",
            bizId: "66ba3e71000000001d030729",
            extraInfo: "{}",
          },
        ],
      },
    ]);
  });

  it("不声明原创时该数组为空（不是省略键）", () => {
    expect(JSON.parse(buildBusinessBinds()).optionRelationList).toEqual([]);
  });

  it("键顺序与网页版抓包实样一致——顺序漂移过发布可能被拒", () => {
    expect(Object.keys(JSON.parse(buildBusinessBinds({ originalUserId: "u" })))).toEqual([
      "version",
      "noteId",
      "bizType",
      "noteOrderBind",
      "notePostTiming",
      "noteCollectionBind",
      "noteSketchCollectionBind",
      "coProduceBind",
      "noteCopyBind",
      "interactionPermissionBind",
      "optionRelationList",
    ]);
  });
});

describe("buildDesc", () => {
  it("标签写成可点击话题的固定格式 `#name[话题]#`，与正文空一行", () => {
    expect(buildDesc("正文", ["#求职", "#北美"]).desc).toBe("正文\n\n#求职[话题]# #北美[话题]#");
  });

  it("传 HashTag 与传标签名出的字一样（前端预览与实际发布一致）", () => {
    expect(buildDesc("正文", [topic("求职")]).desc).toBe(buildDesc("正文", ["#求职"]).desc);
  });

  it("没有标签时只留正文", () => {
    expect(buildDesc("正文", []).desc).toBe("正文");
  });

  it("忽略空白标签", () => {
    expect(buildDesc("正文", ["  ", "#a"]).desc).toBe("正文\n\n#a[话题]#");
  });

  it("正文为空时只留标签", () => {
    expect(buildDesc("   ", ["#a"]).desc).toBe("#a[话题]#");
  });

  it("没超上限时不标记截断，keptTags = 全部", () => {
    const r = buildDesc("短正文", ["#a", "#b"]);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBe(0);
    expect(r.keptTags).toBe(2);
  });
});

describe("buildDesc 超长截断", () => {
  const TAGS = ["#北美求职", "#找工作"];
  const CTA = '有需要进一步咨询以及帮助的同学 可以评论"dd"';
  /** 与实现同口径：UTF-16 单元数 */
  const len = (s: string) => s.length;

  it("超上限时标签一定保住——这是流量入口，绝不能被砍", () => {
    const body = "很".repeat(2000);
    const r = buildDesc(body, TAGS, { limit: 300 });
    expect(r.desc.endsWith("#北美求职[话题]# #找工作[话题]#")).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.keptTags).toBe(2);
  });

  it("超上限时正文末尾的 CTA 被挪到标签前保住", () => {
    const body = `${"很".repeat(2000)}\n\n${CTA}`;
    const r = buildDesc(body, TAGS, { limit: 300, ctaLine: CTA });
    expect(r.desc).toContain(CTA);
    expect(r.desc.endsWith("#北美求职[话题]# #找工作[话题]#")).toBe(true);
    // CTA 在标签之前
    expect(r.desc.indexOf(CTA)).toBeLessThan(r.desc.indexOf("#北美求职"));
  });

  it("CTA 只保留一份，不会在正文里重复出现", () => {
    const body = `正文正文\n\n${CTA}`;
    const r = buildDesc(body, TAGS, { limit: 1000, ctaLine: CTA });
    expect(r.desc.split(CTA)).toHaveLength(2); // 出现且仅出现一次
    expect(r.truncated).toBe(false);
  });

  it("最终长度不超过上限", () => {
    const body = "很".repeat(5000);
    const r = buildDesc(body, TAGS, { limit: 400, ctaLine: CTA });
    expect([...r.desc].length).toBeLessThanOrEqual(400);
    expect(r.length).toBe([...r.desc].length);
    expect(r.limit).toBe(400);
  });

  it("优先断在换行处，不把段落切一半", () => {
    const body = `${"甲".repeat(100)}\n${"乙".repeat(100)}\n${"丙".repeat(100)}`;
    const r = buildDesc(body, [], { limit: 250 });
    expect(r.desc.endsWith("甲".repeat(100) + "\n" + "乙".repeat(100))).toBe(true);
    expect(r.desc).not.toContain("丙");
  });

  it("没有换行时断在句末标点后，不留半句话", () => {
    const body = `${"甲".repeat(80)}。${"乙".repeat(80)}。${"丙".repeat(80)}。`;
    const r = buildDesc(body, [], { limit: 200 });
    expect(r.desc.endsWith("。")).toBe(true);
    expect(r.desc).not.toContain("丙");
  });

  it("整段没有任何断点时硬断并加省略号", () => {
    const r = buildDesc("很".repeat(500), [], { limit: 100 });
    expect(r.desc.endsWith("…")).toBe(true);
    expect(r.desc.length).toBeLessThanOrEqual(100);
  });

  it("emoji 不会被劈成半个（按 UTF-16 计长，按码点切）", () => {
    // 每个 🌍 占 2 个 UTF-16 单元；限额设成奇数，逼它在 emoji 中间做取舍
    const r = buildDesc("🌍".repeat(50), [], { limit: 21 });
    expect(r.desc.length).toBeLessThanOrEqual(21);
    // 没有落单的代理项 = 没有被劈开的 emoji
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.desc)).toBe(false);
  });

  it("长度按 UTF-16 计：含 emoji 的正文不会因为低估而超限", () => {
    const body = `${"字".repeat(100)}${"🌍".repeat(20)}`;
    const r = buildDesc(body, ["#a"], { limit: 80 });
    expect(r.desc.length).toBeLessThanOrEqual(80);
  });

  it("标签本身就撑爆预算时舍弃正文、保住标签", () => {
    const manyTags = Array.from({ length: 30 }, (_, i) => `#超长标签名称${i}`);
    const r = buildDesc("正文".repeat(50), manyTags, { limit: 120 });
    expect(r.truncated).toBe(true);
    expect(r.desc).toContain("#超长标签名称0[话题]#");
    expect([...r.desc].length).toBeLessThanOrEqual(120);
  });

  it("正文超长时来源署名照样保住——它在受保护的尾部，不跟着正文被截", () => {
    // 线上真踩过：署名先拼在正文末尾 → caption 到 1778 字被截 → 署名整块消失、CTA 和话题却还在
    const sourceLines = ["来源:USCIS -> Optional Practical Training Extension for STEM Students"];
    const r = buildDesc("很".repeat(3000), TAGS, { limit: 400, ctaLine: CTA, sourceLines });
    expect(r.desc).toContain(sourceLines[0]);
    expect(r.keptSources).toBe(true);
    expect([...r.desc].length).toBeLessThanOrEqual(400);
  });

  it("版式固定：正文 → 来源 → CTA → 话题", () => {
    const sourceLines = ["来源:USCIS -> A", "来源:ICE SEVP -> B"];
    const r = buildDesc("正文", TAGS, { limit: 1000, ctaLine: CTA, sourceLines });
    expect(r.desc.indexOf("正文")).toBeLessThan(r.desc.indexOf("来源:USCIS"));
    expect(r.desc.indexOf("来源:USCIS")).toBeLessThan(r.desc.indexOf("来源:ICE SEVP"));
    expect(r.desc.indexOf("来源:ICE SEVP")).toBeLessThan(r.desc.indexOf(CTA));
    expect(r.desc.indexOf(CTA)).toBeLessThan(r.desc.indexOf("#北美求职"));
    expect(r.desc.trimEnd().endsWith("#找工作[话题]#")).toBe(true);
  });

  it("正文自带 CTA 结尾时不会重复一份，署名插在它前面", () => {
    const r = buildDesc(`正文\n\n${CTA}`, [], {
      limit: 1000,
      ctaLine: CTA,
      sourceLines: ["来源:USCIS -> A"],
    });
    expect(r.desc.split(CTA)).toHaveLength(2);
    expect(r.desc.indexOf("来源:USCIS")).toBeLessThan(r.desc.indexOf(CTA));
  });

  it("额度极小时先丢标签、再丢署名，CTA 最后才动", () => {
    const r = buildDesc("正文", TAGS, {
      limit: len(CTA) + 4,
      ctaLine: CTA,
      sourceLines: ["来源:USCIS -> 一个很长很长很长的官方页面标题"],
    });
    expect(r.desc).toContain(CTA);
    expect(r.keptSources).toBe(false);
    expect(r.keptTags).toBe(0);
    expect(r.truncated).toBe(true);
  });

  it("标签放不下时整个整个地丢，绝不留半截话题——keptTags 与 desc 严格对得上", () => {
    const manyTags = Array.from({ length: 30 }, (_, i) => `#超长标签名称${i}`);
    const r = buildDesc("正文".repeat(50), manyTags, { limit: 120 });
    expect(r.keptTags).toBeGreaterThan(0);
    expect(r.keptTags).toBeLessThan(manyTags.length);
    // desc 里出现的话题个数 == keptTags，且每个都是完整的 `#name[话题]#`
    expect(r.desc.match(/#[^#]+\[话题\]#/g) ?? []).toHaveLength(r.keptTags);
    // 被丢掉的那些一个字都没留下
    for (let i = r.keptTags; i < manyTags.length; i += 1) {
      expect(r.desc).not.toContain(`超长标签名称${i}`);
    }
  });
});
