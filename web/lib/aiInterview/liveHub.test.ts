import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { publishLive, liveSnapshot } from "./liveHub";
import { EMPTY_LIVE_STATE } from "./schema";

/**
 * 副屏的「单发布者」归属权。
 *
 * 这套规则本来只解决一个问题:Mac 上很容易同时留着两个 Autoxhs 网页(旧标签页没关、
 * 或者刷新出了新的),两个都在推心跳,手机就在两场面试之间来回跳。于是定了「谁开得晚
 * 谁赢」。
 *
 * 2026-07-31 它咬人了:桌面端 natively 正在面试、手机好好地看着答案,用户在 Mac 上
 * 打开了网页版 /ai-interview。那个页面一挂载就取配对码、并且从此每隔几秒推一帧心跳,
 * 哪怕它自己一场面试都没开(live:false)。它的 startedAt 是「页面打开时间」,必然比
 * 桌面端的「会议开始时间」新 —— 当场夺权,桌面端退避后继续输,手机上变成「Mac 端已
 * 暂停」,面试进行到一半。
 *
 * 修法:跨类别时「谁真的在面试」优先于「谁开得晚」。同类别之间(两个闲着的标签页、
 * 两个都在跑的)保持原样。
 */

const OWNER_STALE_MS = 8_000;

/**
 * hub 是挂在 globalThis 上的单例(防 dev HMR 重建),没有 reset 接口 —— 那是有意的,
 * 生产里它本来就该活得比任何一个请求久。所以这里不假装能清空它,而是接管时钟:每个
 * 用例开始前把时间往前推,上一个用例留下的 owner 自然过期,起点就干净了。
 */
let clock = 0;
const realNow = Date.now;

beforeAll(() => {
  clock = realNow();
  Date.now = () => clock;
});
afterAll(() => {
  Date.now = realNow;
});
beforeEach(() => {
  clock += 10 * OWNER_STALE_MS;
});

const frame = (live: boolean, answer = "") => ({ ...EMPTY_LIVE_STATE, live, answer });

let seq = 0;
/** 一个发布者:`agoMs` 是它「开始」于多久以前(桌面端=会议开始,网页=页面打开)。 */
const pub = (agoMs: number) => ({ id: `p${++seq}`, startedAt: clock - agoMs });

describe("publishLive — 归属权", () => {
  it("正在面试的桌面端,不会被刚打开的网页顶掉", () => {
    const desktop = pub(60_000); // 会议 60 秒前开始
    expect(publishLive(desktop, frame(true, "桌面端的答案")).accepted).toBe(true);

    // 网页版刚打开:startedAt 更新,但它自己没在面试。
    const webTab = pub(0);
    expect(publishLive(webTab, frame(false)).accepted).toBe(false);
    expect(liveSnapshot().answer).toBe("桌面端的答案");

    // 桌面端继续推,照样是它的。
    expect(publishLive(desktop, frame(true, "下一题的答案")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("下一题的答案");
  });

  it("网页版真的开了一场面试,就该让位", () => {
    const desktop = pub(60_000);
    expect(publishLive(desktop, frame(true, "桌面端")).accepted).toBe(true);

    // 这次它 live=true —— 用户显然是想用网页版了。
    const webTab = pub(0);
    expect(publishLive(webTab, frame(true, "网页版")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("网页版");
    expect(publishLive(desktop, frame(true, "桌面端again")).accepted).toBe(false);
  });

  it("闲着的主人,会被一个真的开跑的发布者接管(哪怕对方开得更早)", () => {
    const idleTab = pub(0);
    expect(publishLive(idleTab, frame(false, "闲着的标签页")).accepted).toBe(true);

    // 桌面端会议其实开得更早,但它在跑。
    const desktop = pub(60_000);
    expect(publishLive(desktop, frame(true, "桌面端开跑了")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("桌面端开跑了");
  });

  it("两个都闲着时,仍然是开得晚的赢(原有规则不变)", () => {
    const older = pub(60_000);
    expect(publishLive(older, frame(false, "旧标签页")).accepted).toBe(true);

    const newer = pub(0);
    expect(publishLive(newer, frame(false, "新标签页")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("新标签页");
    expect(publishLive(older, frame(false, "旧的又推")).accepted).toBe(false);
  });

  it("两个都在面试时,也是开得晚的赢", () => {
    const older = pub(60_000);
    expect(publishLive(older, frame(true, "先开的")).accepted).toBe(true);
    const newer = pub(0);
    expect(publishLive(newer, frame(true, "后开的")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("后开的");
  });

  it("主人没声了就让位 —— 面试中也一样(进程挂了 / 断网了)", () => {
    const dead = pub(60_000);
    expect(publishLive(dead, frame(true, "挂掉前的最后一帧")).accepted).toBe(true);

    clock += OWNER_STALE_MS + 1_000;
    // 接管者比死掉那个开得还早,靠的是「原主人过期」而不是「我更新」。
    const rescuer = pub(120_000);
    expect(publishLive(rescuer, frame(false, "接管")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("接管");
  });

  it("同一个发布者永远能继续推自己的帧", () => {
    const me = pub(0);
    expect(publishLive(me, frame(true, "1")).accepted).toBe(true);
    expect(publishLive(me, frame(false, "2")).accepted).toBe(true);
    expect(publishLive(me, frame(true, "3")).accepted).toBe(true);
    expect(liveSnapshot().answer).toBe("3");
  });
});

describe("订阅者清理", () => {
  it("写不进去的副屏会被摘掉,不会每帧抛一次并虚报在线数", async () => {
    const { subscribeLive, viewerCount } = await import("./liveHub");
    const before = viewerCount();
    subscribeLive(() => { throw new Error("controller already closed"); });
    expect(viewerCount()).toBe(before + 1);

    const me = pub(0);
    publishLive(me, frame(true, "一帧"));
    expect(viewerCount()).toBe(before);
  });

  it("一个坏订阅者不影响其他人收帧", async () => {
    const { subscribeLive } = await import("./liveHub");
    const got: string[] = [];
    subscribeLive(() => { throw new Error("dead"); });
    const off = subscribeLive((s) => { got.push(s.answer); });
    try {
      publishLive(pub(0), frame(true, "送到了"));
      expect(got).toContain("送到了");
    } finally {
      off();
    }
  });
});
