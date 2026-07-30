import { describe, expect, it } from "vitest";

import { splitLayered } from "./layered";

const FULL = `速读:读不加锁(volatile read);写只锁那个 bucket —— 空桶 CAS、冲突才 synchronized;链表过长转 tree bin
照着说:Reads don't lock — the table and nodes are volatile reads. Writes only lock the affected bucket.
还可以补:resize 协作搬 · tree bin 阈值 8`;

describe("splitLayered", () => {
  it("三段都能分出来", () => {
    const r = splitLayered(FULL);
    expect(r.gist).toContain("volatile read");
    expect(r.gist).toContain("bucket");
    expect(r.speak.startsWith("Reads don't lock")).toBe(true);
    expect(r.extra).toContain("tree bin 阈值 8");
    expect(r.plain).toBe("");
  });

  it("流式中途:只到一半也能显示已有的部分", () => {
    const r = splitLayered("速读:读不加锁(volatile read);写只锁那个 buck");
    expect(r.gist).toContain("volatile read");
    expect(r.speak).toBe("");
    expect(r.plain).toBe("");
  });

  it("英文那段还在写的时候,速读已经完整可读", () => {
    const r = splitLayered("速读:空桶 CAS、冲突才 synchronized\n照着说:Reads don't lo");
    expect(r.gist).toBe("空桶 CAS、冲突才 synchronized");
    expect(r.speak).toBe("Reads don't lo");
  });

  it("全角冒号 / 加粗 / 方括号都认", () => {
    const r = splitLayered("**速读**:骨架\n【照着说】:say this\n还可以补 : 补点");
    expect(r.gist).toBe("骨架");
    expect(r.speak).toBe("say this");
    expect(r.extra).toBe("补点");
  });

  it("没有「还可以补」也正常(模型判断没什么可补的)", () => {
    const r = splitLayered("速读:骨架\n照着说:say this");
    expect(r.extra).toBe("");
    expect(r.speak).toBe("say this");
  });

  it("模型没按格式输出时原样显示,不能变空白", () => {
    const raw = "I make the consumer idempotent by giving every event a stable key.";
    const r = splitLayered(raw);
    expect(r.plain).toBe(raw);
    expect(r.gist).toBe("");
  });

  it("只有标签、正文全空 → 退回纯文本,不显示三个空框", () => {
    const r = splitLayered("速读:\n照着说:\n还可以补:");
    expect(r.plain).not.toBe("");
    expect(r.gist).toBe("");
  });

  it("空输入不炸", () => {
    const r = splitLayered("   ");
    expect(r).toEqual({ gist: "", speak: "", extra: "", plain: "" });
  });

  it("答案正文里出现「速读」二字(非行首标签)不会误切", () => {
    const r = splitLayered("照着说:We call this the 速读 pattern internally.");
    expect(r.speak).toContain("速读 pattern");
    expect(r.gist).toBe("");
  });
});
