import { describe, expect, it } from "vitest";

import { OutlineValidationError, normalizeOutline } from "./schema";

type RawCard = Record<string, unknown>;

function card(over: RawCard = {}): RawCard {
  return {
    kind: "content",
    layout: "balanced",
    title: "标题",
    subtitle: null,
    badge: null,
    items: [{ label: null, text: "要点一" }],
    groups: [],
    ...over,
  };
}

function outline(cards: RawCard[]) {
  return { topic: "主题", style: "notion", palette: "default", cards };
}

describe("normalizeOutline", () => {
  it("强制第一张是封面、最后一张是结尾，都走 sparse", () => {
    const r = normalizeOutline(outline([card(), card(), card()]), "兜底");
    expect(r.cards[0]).toMatchObject({ kind: "cover", layout: "sparse" });
    expect(r.cards[2]).toMatchObject({ kind: "ending", layout: "sparse" });
    expect(r.cards[1].kind).toBe("content");
  });

  it("卡片数不足时抛错以触发重试", () => {
    expect(() => normalizeOutline(outline([card(), card()]), "兜底")).toThrow(
      OutlineValidationError,
    );
  });

  it("超过上限时从中间砍，保住封面和结尾", () => {
    const many = Array.from({ length: 14 }, (_, i) => card({ title: `第${i}张` }));
    const r = normalizeOutline(outline(many), "兜底");
    expect(r.cards).toHaveLength(10);
    expect(r.cards[0].title).toBe("第0张");
    expect(r.cards[9].title).toBe("第13张");
  });

  it("comparison 分组数不对时退回按要点排版，而不是丢内容", () => {
    const bad = card({
      layout: "comparison",
      groups: [{ heading: "只有一组", items: ["a"] }],
      items: [
        { label: null, text: "要点一" },
        { label: null, text: "要点二" },
        { label: null, text: "要点三" },
      ],
    });
    const r = normalizeOutline(outline([card(), bad, card()]), "兜底");
    expect(r.cards[1].layout).toBe("balanced");
    expect(r.cards[1].items).toHaveLength(3);
  });

  it("comparison 正好两组时保留原版式", () => {
    const ok = card({
      layout: "comparison",
      items: [],
      groups: [
        { heading: "左", items: ["a"] },
        { heading: "右", items: ["b"] },
      ],
    });
    const r = normalizeOutline(outline([card(), ok, card()]), "兜底");
    expect(r.cards[1].layout).toBe("comparison");
  });

  it("要点超出版式上限时升级版式，一条都不丢", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ label: null, text: `要点${i}` }));
    const r = normalizeOutline(outline([card(), card({ layout: "balanced", items }), card()]), "兜底");
    expect(r.cards[1].layout).toBe("dense");
    expect(r.cards[1].items).toHaveLength(8);
  });

  it("内容页一条要点都没有时退回 sparse", () => {
    const r = normalizeOutline(
      outline([card(), card({ layout: "list", items: [], groups: [] }), card()]),
      "兜底",
    );
    expect(r.cards[1].layout).toBe("sparse");
  });

  it("清洗空白并把空串归一成 null", () => {
    const r = normalizeOutline(
      outline([
        card(),
        card({ title: "  标题  里有  空格 ", subtitle: "   ", badge: " 干货 " }),
        card(),
      ]),
      "兜底",
    );
    expect(r.cards[1].title).toBe("标题 里有 空格");
    expect(r.cards[1].subtitle).toBeNull();
    expect(r.cards[1].badge).toBe("干货");
  });

  it("丢弃空标题的卡片", () => {
    const r = normalizeOutline(outline([card(), card({ title: "   " }), card(), card()]), "兜底");
    expect(r.cards).toHaveLength(3);
  });

  it("不截断任何文字——超长要点原样保留，交给渲染层降字号", () => {
    const long = "很".repeat(200);
    const r = normalizeOutline(
      outline([card(), card({ items: [{ label: null, text: long }] }), card()]),
      "兜底",
    );
    expect(r.cards[1].items[0].text).toHaveLength(200);
  });

  it("topic 为空时用兜底主题", () => {
    const r = normalizeOutline({ ...outline([card(), card(), card()]), topic: "  " }, "兜底主题");
    expect(r.topic).toBe("兜底主题");
  });

  it("watermark 不由模型决定，一律先置空", () => {
    const r = normalizeOutline(outline([card(), card(), card()]), "兜底");
    expect(r.watermark).toBeNull();
  });
});
