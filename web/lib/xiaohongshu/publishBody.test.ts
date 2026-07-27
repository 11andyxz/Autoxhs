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
    expect(buildDesc("正文", ["#求职", "#北美"])).toBe("正文\n\n#求职 #北美");
  });

  it("没有标签时只留正文", () => {
    expect(buildDesc("正文", [])).toBe("正文");
  });

  it("忽略空白标签", () => {
    expect(buildDesc("正文", ["  ", "#a"])).toBe("正文\n\n#a");
  });

  it("正文为空时只留标签", () => {
    expect(buildDesc("   ", ["#a"])).toBe("#a");
  });
});
