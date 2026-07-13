import { describe, expect, it } from "vitest";

import { IMAGE_TEXT_LIMIT, NOTE_DESC_LIMIT, buildNoteContext } from "./comment";

describe("buildNoteContext", () => {
  it("标题+正文：无图片文字段落（旧行为不变）", () => {
    const ctx = buildNoteContext({ title: "圣何塞租房", desc: "独立屋次卧，带健身房" });
    expect(ctx).toContain("【笔记标题】\n圣何塞租房");
    expect(ctx).toContain("【笔记正文】\n独立屋次卧，带健身房");
    expect(ctx).not.toContain("【笔记图片中的文字】");
  });

  it("带 imageText：追加「笔记图片中的文字」段落", () => {
    const ctx = buildNoteContext({
      title: "美国当兵",
      desc: "",
      imageText: "入伍流程\n体检要求\n绿卡加速",
    });
    expect(ctx).toContain("【笔记标题】\n美国当兵");
    expect(ctx).toContain("【笔记图片中的文字】\n入伍流程\n体检要求\n绿卡加速");
    // desc 为空时不产生空的正文段落
    expect(ctx).not.toContain("【笔记正文】");
  });

  it("空/纯空白 imageText 不产生段落", () => {
    expect(buildNoteContext({ title: "T", imageText: "" })).not.toContain("【笔记图片中的文字】");
    expect(buildNoteContext({ title: "T", imageText: "   \n  " })).not.toContain(
      "【笔记图片中的文字】",
    );
  });

  it("imageText 超长按 IMAGE_TEXT_LIMIT 截断", () => {
    const long = "字".repeat(IMAGE_TEXT_LIMIT + 500);
    const ctx = buildNoteContext({ title: "T", imageText: long });
    const section = ctx.split("【笔记图片中的文字】\n")[1] ?? "";
    expect(section.length).toBe(IMAGE_TEXT_LIMIT);
  });

  it("desc 与 imageText 各自独立截断", () => {
    const ctx = buildNoteContext({
      title: "T",
      desc: "正".repeat(NOTE_DESC_LIMIT + 100),
      imageText: "图".repeat(IMAGE_TEXT_LIMIT + 100),
    });
    const descSection = (ctx.split("【笔记正文】\n")[1] ?? "").split("\n\n")[0];
    const imgSection = ctx.split("【笔记图片中的文字】\n")[1] ?? "";
    expect(descSection.length).toBe(NOTE_DESC_LIMIT);
    expect(imgSection.length).toBe(IMAGE_TEXT_LIMIT);
  });

  it("全空 → 空串", () => {
    expect(buildNoteContext({})).toBe("");
  });
});
