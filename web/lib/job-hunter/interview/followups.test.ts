import { describe, expect, it } from "vitest";

import {
  MAX_FOLLOWUPS,
  MAX_FOLLOWUP_A,
  MAX_FOLLOWUP_Q,
  appendFollowup,
  parseFollowups,
  removeFollowup,
  serializeFollowups,
} from "./followups";

/**
 * 卡片里的「就地追问」问答列表。它跟卡片一起复习,所以怕两件事:
 * 一条脏数据把整张卡的追问全废掉,和无上限增长把 MEDIUMTEXT 撑爆。两条都在这里钉住。
 */

describe("parseFollowups", () => {
  it("正常 JSON 数组照原样解析", () => {
    const raw = JSON.stringify([{ id: 1, q: "这个 super 是什么意思", a: "调用父类构造器", ref: "A.java" }]);
    expect(parseFollowups(raw)).toEqual([{ id: 1, ref: "A.java", q: "这个 super 是什么意思", a: "调用父类构造器" }]);
  });

  it("坏 JSON / 非数组 / 空 → 空数组,不抛错", () => {
    for (const raw of ["{oops", "null", '"str"', "{}", "", null, undefined]) {
      expect(parseFollowups(raw as string | null)).toEqual([]);
    }
  });

  it("形状不对的条目单独丢掉,不影响同一张卡里正常的那些", () => {
    const raw = JSON.stringify([
      { id: 1, q: "好问题", a: "好回答" },
      { id: 2, q: "", a: "没有问题就不是一条追问" },
      { id: 3, q: "没有回答也不是", a: "   " },
      null,
      "junk",
      { id: 4, q: "第二条好的", a: "答" },
    ]);
    expect(parseFollowups(raw).map((f) => f.q)).toEqual(["好问题", "第二条好的"]);
  });

  it("超长的问/答按上限截断", () => {
    const raw = JSON.stringify([{ id: 1, q: "q".repeat(9999), a: "a".repeat(99999) }]);
    const [f] = parseFollowups(raw);
    expect(f.q).toHaveLength(MAX_FOLLOWUP_Q);
    expect(f.a).toHaveLength(MAX_FOLLOWUP_A);
  });

  it("超过条数上限只保留最近的", () => {
    const raw = JSON.stringify(Array.from({ length: MAX_FOLLOWUPS + 5 }, (_, i) => ({ id: i + 1, q: `q${i}`, a: "a" })));
    const list = parseFollowups(raw);
    expect(list).toHaveLength(MAX_FOLLOWUPS);
    expect(list[list.length - 1].q).toBe(`q${MAX_FOLLOWUPS + 4}`);
  });
});

describe("appendFollowup", () => {
  it("id 自增,不改入参", () => {
    const list = [{ id: 7, q: "a", a: "b" }];
    const next = appendFollowup(list, { q: "新问题", a: "新回答", ref: "X.java" });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ id: 8, q: "新问题", a: "新回答", ref: "X.java" });
    expect(list).toHaveLength(1); // 原数组没被动过
  });

  it("没有 ref(针对整张卡问的)就不写这个字段", () => {
    expect(appendFollowup([], { q: "q", a: "a" })).toEqual([{ id: 1, q: "q", a: "a" }]);
    expect(appendFollowup([], { q: "q", a: "a", ref: "  " })).toEqual([{ id: 1, q: "q", a: "a" }]);
  });

  it("满了丢最早的一条", () => {
    let list = Array.from({ length: MAX_FOLLOWUPS }, (_, i) => ({ id: i + 1, q: `q${i}`, a: "a" }));
    list = appendFollowup(list, { q: "最新", a: "a" });
    expect(list).toHaveLength(MAX_FOLLOWUPS);
    expect(list[0].q).toBe("q1"); // q0 被挤掉
    expect(list[list.length - 1].q).toBe("最新");
  });
});

describe("removeFollowup / serializeFollowups", () => {
  it("按 id 删,删不到就原样", () => {
    const list = [
      { id: 1, q: "a", a: "1" },
      { id: 2, q: "b", a: "2" },
    ];
    expect(removeFollowup(list, 1).map((f) => f.id)).toEqual([2]);
    expect(removeFollowup(list, 99)).toHaveLength(2);
  });

  it("空列表存 NULL(而不是字符串 \"[]\")", () => {
    expect(serializeFollowups([])).toBeNull();
    expect(serializeFollowups([{ id: 1, q: "q", a: "a" }])).toBe('[{"id":1,"q":"q","a":"a"}]');
  });

  it("存进去再读出来是同一份(round-trip)", () => {
    const list = appendFollowup(appendFollowup([], { q: "q1", a: "a1" }), { q: "q2", a: "a2", ref: "F.java" });
    expect(parseFollowups(serializeFollowups(list))).toEqual(list);
  });
});
