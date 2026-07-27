import { describe, expect, it } from "vitest";

import {
  PRIVACY_PUBLIC,
  PRIVACY_SELF,
  buildDesc,
  buildImageNoteBody,
} from "./publishBody";

const IMAGES = [
  { fileId: "a1", width: 1440, height: 1920 },
  { fileId: "b2", width: 1440, height: 1920 },
];

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
    expect(body.common.business_binds).toContain('"interactionPermissionBind":{"commentPermission":0}');
    expect(body.common.business_binds).toContain('"coProduceBind":{"enable":true}');
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

describe("buildDesc", () => {
  it("正文与标签之间空一行", () => {
    expect(buildDesc("正文", ["#求职", "#北美"]).desc).toBe("正文\n\n#求职 #北美");
  });

  it("没有标签时只留正文", () => {
    expect(buildDesc("正文", []).desc).toBe("正文");
  });

  it("忽略空白标签", () => {
    expect(buildDesc("正文", ["  ", "#a"]).desc).toBe("正文\n\n#a");
  });

  it("正文为空时只留标签", () => {
    expect(buildDesc("   ", ["#a"]).desc).toBe("#a");
  });

  it("没超上限时不标记截断", () => {
    const r = buildDesc("短正文", ["#a"]);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBe(0);
  });
});

describe("buildDesc 超长截断", () => {
  const TAGS = ["#北美求职", "#找工作"];
  const CTA = '有需要进一步咨询以及帮助的同学 可以评论"dd"';

  it("超上限时标签一定保住——这是流量入口，绝不能被砍", () => {
    const body = "很".repeat(2000);
    const r = buildDesc(body, TAGS, { limit: 300 });
    expect(r.desc.endsWith("#北美求职 #找工作")).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toBeGreaterThan(0);
  });

  it("超上限时正文末尾的 CTA 被挪到标签前保住", () => {
    const body = `${"很".repeat(2000)}\n\n${CTA}`;
    const r = buildDesc(body, TAGS, { limit: 300, ctaLine: CTA });
    expect(r.desc).toContain(CTA);
    expect(r.desc.endsWith("#北美求职 #找工作")).toBe(true);
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
    expect(r.desc).toContain("#超长标签名称0");
    expect([...r.desc].length).toBeLessThanOrEqual(120);
  });
});
