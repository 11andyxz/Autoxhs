import { describe, expect, it } from "vitest";

import { EMPTY_LIVE_STATE, LIMITS, parseLiveState } from "./schema";
import { drainLiveCommands, enqueueLiveCommand, liveCode, checkCode } from "./liveHub";

/**
 * 副屏这条链路的「信任边界」测试。
 *
 * 帧是桌面端另一个进程 POST 过来的,命令是手机点出来的 —— 两边都不可信,而这两样东西
 * 一个直接渲染给正在面试的人看,一个会在 Mac 上变成合成按键。所以这里测的不是「正常
 * 情况对不对」,是「喂垃圾进去会怎样」。
 *
 * 2026-07-31 的教训:桌面端曾经漏发 perfectState/perfectAnswer/perfectNote 三个字段,
 * parseLiveState 老老实实地把它们补成默认值,于是「完美答案」按钮一次都没渲染出来过,
 * 两端代码都对、中间静默丢失。所以下面有一条专门盯「schema 默认值不能掩盖缺字段」。
 */

describe("parseLiveState — 帧来自另一个进程,什么都可能是", () => {
  it("完全的垃圾输入也能产出一帧合法快照", () => {
    for (const junk of [null, undefined, 0, "", "not an object", [], true, NaN]) {
      const s = parseLiveState(junk);
      expect(typeof s.answer).toBe("string");
      expect(typeof s.live).toBe("boolean");
      expect(Array.isArray(s.transcript)).toBe(true);
      expect(s.perfectState).toBe("none");
    }
  });

  it("类型错了不会抛,只会被规整", () => {
    const s = parseLiveState({
      live: "yes",              // 不是 boolean
      company: 12345,           // 不是 string
      elapsedMs: "abc",
      confidence: "high",
      answer: { nope: 1 },
      transcript: "not an array",
      perfectState: "hacked",
      sttFailed: -5,
    });
    expect(s.live).toBe(false);
    expect(s.elapsedMs).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.transcript).toEqual([]);
    expect(s.perfectState).toBe("none");
    expect(s.sttFailed).toBe(0);
  });

  it("perfectState 只认白名单里的四个值", () => {
    for (const ok of ["running", "already", "ready", "skipped"]) {
      expect(parseLiveState({ perfectState: ok }).perfectState).toBe(ok);
    }
    for (const bad of ["none", "RUNNING", "done", 1, null, {}]) {
      expect(parseLiveState({ perfectState: bad }).perfectState).toBe("none");
    }
  });

  it("超长内容被截断,不会把手机撑爆", () => {
    const huge = "x".repeat(500_000);
    const s = parseLiveState({ answer: huge, question: huge, perfectAnswer: huge, perfectNote: huge });
    expect(s.answer.length).toBeLessThanOrEqual(LIMITS.prevAnswer);
    expect(s.question.length).toBeLessThanOrEqual(LIMITS.question);
    expect(s.perfectAnswer.length).toBeLessThanOrEqual(LIMITS.prevAnswer);
    expect(s.perfectNote.length).toBeLessThanOrEqual(200);
  });

  it("elapsedMs 不会是负数或 Infinity", () => {
    expect(parseLiveState({ elapsedMs: -1000 }).elapsedMs).toBe(0);
    expect(parseLiveState({ elapsedMs: Infinity }).elapsedMs).toBe(0);
    expect(parseLiveState({ elapsedMs: 1234.7 }).elapsedMs).toBe(1235);
  });

  it("confidence 被夹在 0..1", () => {
    expect(parseLiveState({ confidence: 5 }).confidence).toBe(1);
    expect(parseLiveState({ confidence: -5 }).confidence).toBe(0);
    expect(parseLiveState({ confidence: 0.42 }).confidence).toBeCloseTo(0.42);
  });

  it("transcript 里的脏数据被丢掉,不会连累整帧", () => {
    const s = parseLiveState({
      transcript: [
        { role: "interviewer", text: "真的一句话", at: 100 },
        null,
        "字符串不是 turn",
        { role: "怪角色", text: "x", at: 1 },
        { text: "没有 role" },
        42,
      ],
    });
    expect(Array.isArray(s.transcript)).toBe(true);
    for (const t of s.transcript) {
      expect(typeof t.text).toBe("string");
      expect(["interviewer", "me", "assistant"]).toContain(t.role);
    }
  });

  it("原型污染形状的键不会落到快照上", () => {
    const s = parseLiveState(JSON.parse('{"__proto__":{"polluted":true},"answer":"ok"}'));
    expect(s.answer).toBe("ok");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("EMPTY_LIVE_STATE 的每个字段 parseLiveState 都产出(除服务端盖的 v/at)", () => {
    // 这条是那次事故的直接护栏:少一个字段不会报错,只会静默变默认值。
    const produced = parseLiveState({});
    const expectedKeys = Object.keys(EMPTY_LIVE_STATE).filter((k) => k !== "v" && k !== "at");
    for (const k of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(produced, k)).toBe(true);
    }
  });
});

describe("命令队列 —— 手机点出来的东西最终会变成 Mac 上的按键", () => {
  it("排队后能被取走,取走即清空(重发一次比漏一次好)", () => {
    drainLiveCommands();
    enqueueLiveCommand("takeScreenshot");
    enqueueLiveCommand("whatToAnswer");
    const first = drainLiveCommands();
    expect(first.map((c) => c.type)).toEqual(["takeScreenshot", "whatToAnswer"]);
    expect(drainLiveCommands()).toEqual([]);
  });

  it("副屏断网时连点很多下,队列有上限不会攒着一起爆发", () => {
    drainLiveCommands();
    for (let i = 0; i < 50; i += 1) enqueueLiveCommand("takeScreenshot");
    const drained = drainLiveCommands();
    expect(drained.length).toBeLessThanOrEqual(6);
  });

  it("超限时丢最旧的,保留最新意图", () => {
    drainLiveCommands();
    for (let i = 0; i < 6; i += 1) enqueueLiveCommand("takeScreenshot");
    enqueueLiveCommand("whatToAnswer");
    const drained = drainLiveCommands();
    expect(drained[drained.length - 1].type).toBe("whatToAnswer");
  });

  it("每条命令有唯一 id 和时间戳", () => {
    drainLiveCommands();
    enqueueLiveCommand("takeScreenshot");
    enqueueLiveCommand("takeScreenshot");
    const [a, b] = drainLiveCommands();
    expect(a.id).not.toBe(b.id);
    expect(typeof a.at).toBe("number");
  });
});

describe("配对码", () => {
  it("码是固定长度、只用不易看错的字符", () => {
    const code = liveCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
    // 0/o/1/l/i 全部排除 —— 这个码要在手机上手输。
    expect(code).not.toMatch(/[01oli]/);
  });

  it("空码 / 错码 / 非字符串一律拒绝", () => {
    expect(checkCode(null)).toBe(false);
    expect(checkCode("")).toBe(false);
    expect(checkCode("wrong1")).toBe(false);
    expect(checkCode(liveCode().toUpperCase())).toBe(false);
    expect(checkCode(liveCode())).toBe(true);
  });
});

describe("错误通道 —— 手机必须知道为什么不动了", () => {
  it("error 是契约的一部分,不是可选的附加物", () => {
    // 加这个字段之前:答案生成失败、重试耗尽、发布权被抢、采集中断,在手机上
    // 全部是同一个画面 —— 屏幕不动。面试进行中,「它好像卡住了」是最没用的信息。
    expect(Object.prototype.hasOwnProperty.call(EMPTY_LIVE_STATE, "error")).toBe(true);
    expect(parseLiveState({}).error).toBe("");
    expect(parseLiveState({ error: "副屏被另一个发布者接管" }).error).toBe("副屏被另一个发布者接管");
  });

  it("error 被截断,且非字符串不会炸", () => {
    expect(parseLiveState({ error: "x".repeat(5000) }).error.length).toBeLessThanOrEqual(200);
    for (const bad of [null, 123, {}, []]) {
      expect(typeof parseLiveState({ error: bad }).error).toBe("string");
    }
  });

  it("questionKind 只认白名单 —— 它在手机上被当对象 key 查表", () => {
    // KIND_LABEL[state.questionKind] 取到函数/对象再渲染成 React 子节点会抛,
    // 而副屏上没有 error boundary,整页白屏。
    for (const bad of ["__proto__", "constructor", "toString", "随便什么"]) {
      expect(parseLiveState({ questionKind: bad }).questionKind).toBe("");
    }
    expect(parseLiveState({ questionKind: "technical" }).questionKind).toBe("technical");
    expect(parseLiveState({ questionKind: "" }).questionKind).toBe("");
  });
});
