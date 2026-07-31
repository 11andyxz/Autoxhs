import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMAND_TIMEOUT_MS, connLabel, isStale, reconnectDelayMs, STALE_AFTER_MS } from "./viewState";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 副屏页面的判断逻辑。
 *
 * 这些分支决定了「屏幕不动了」的时候人看到什么 —— 而那正是面试中途最需要正确的
 * 一刻:是该等一下,还是该自己开口,还是该去按那个兜底按钮。
 */

const NOW = 1_700_000_000_000;

describe("isStale —— 两个时钟都要新", () => {
  it("刚收到的活跃帧是新鲜的", () => {
    expect(isStale({ live: true, frameAt: NOW - 500, receivedAt: NOW - 500, now: NOW })).toBe(false);
  });

  it("本机很久没收到东西 → 不新鲜", () => {
    expect(isStale({ live: true, frameAt: NOW, receivedAt: NOW - 60_000, now: NOW })).toBe(true);
  });

  it("刚刚收到、但那一帧本身是几小时前的 → 也不新鲜", () => {
    // 这是最阴的一种:手机刚打开,SSE 先补一帧「当前快照」,而那帧是桌面端几小时前
    // 死掉时留下的。只看本机收到时间的话,一场早就结束的面试会显示成正在进行。
    expect(isStale({ live: true, frameAt: NOW - 3_600_000, receivedAt: NOW, now: NOW })).toBe(true);
  });

  it("没在进行中就不谈新鲜度", () => {
    expect(isStale({ live: false, frameAt: NOW - 3_600_000, receivedAt: NOW - 3_600_000, now: NOW })).toBe(false);
  });

  it("还没收到过真帧(frameAt=0)时不据此判定", () => {
    expect(isStale({ live: true, frameAt: 0, receivedAt: NOW, now: NOW })).toBe(false);
  });

  it("阈值是 12 秒 —— 比桌面端 2.5 秒的心跳宽出几倍", () => {
    expect(STALE_AFTER_MS).toBeGreaterThan(2_500 * 3);
    expect(isStale({ live: true, frameAt: NOW - 11_000, receivedAt: NOW - 11_000, now: NOW })).toBe(false);
    expect(isStale({ live: true, frameAt: NOW - 13_000, receivedAt: NOW - 13_000, now: NOW })).toBe(true);
  });
});

describe("reconnectDelayMs —— 403 不再是终态", () => {
  it("普通断线走指数退避,上限 8 秒", () => {
    expect(reconnectDelayMs({ denied: false, attempt: 1 })).toBe(1_000);
    expect(reconnectDelayMs({ denied: false, attempt: 2 })).toBe(2_000);
    expect(reconnectDelayMs({ denied: false, attempt: 3 })).toBe(4_000);
    expect(reconnectDelayMs({ denied: false, attempt: 9 })).toBe(8_000);
  });

  it("判成未配对之后仍然会重试,只是拉长间隔", () => {
    // 配对码是每个 web 进程重新生成的(dev 重启一次就变),桌面端会自己取到新码
    // 继续推 —— 只有手机永远停在「未配对」。
    const d = reconnectDelayMs({ denied: true, attempt: 1 });
    expect(d).toBeGreaterThan(8_000);
    expect(Number.isFinite(d)).toBe(true);
  });

  it("attempt 是 0 或负数也不会变成 0 间隔猛打", () => {
    expect(reconnectDelayMs({ denied: false, attempt: 0 })).toBe(1_000);
    expect(reconnectDelayMs({ denied: false, attempt: -5 })).toBe(1_000);
  });
});

describe("connLabel", () => {
  it("每种状态各有各的说法,不会混", () => {
    const base = { conn: "open" as const, live: true, stale: false, sourceDown: false };
    expect(connLabel({ ...base, conn: "denied" })).toBe("未配对");
    expect(connLabel({ ...base, conn: "lost" })).toBe("重连中");
    expect(connLabel({ ...base, stale: true })).toBe("Mac 端已暂停");
    expect(connLabel({ ...base, live: false })).toBe("未开始");
    expect(connLabel({ ...base, sourceDown: true })).toContain("采集中断");
    expect(connLabel(base)).toBe("进行中");
  });

  it("未配对 / 重连中优先于「进行中」—— 那一帧本来就到不了", () => {
    expect(connLabel({ conn: "denied", live: true, stale: false, sourceDown: false })).toBe("未配对");
    expect(connLabel({ conn: "lost", live: true, stale: false, sourceDown: false })).toBe("重连中");
  });
});

describe("按钮不能永远转圈", () => {
  it("命令请求有超时", () => {
    // sendCommand 原来没有超时,而按钮的 disabled 只在 finally 里清 —— 一个永远
    // 不 settle 的 fetch 会让三个按钮一直是灰的,而那正是最需要「回答这句」的时候。
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("REG-040 这些逻辑必须真的被页面调用,而不只是被 import", () => {
  // 这条护栏来自一次真实的假修复:一个脚本一次做四处替换、最后统一写盘,
  // 第四处锚点没匹配抛异常 → **前三处全部没落盘**。而上面那些测纯函数的用例
  // 照样全绿,读起来完全像「已修复」。
  //
  // 纯函数测试证明不了「页面用了它」。这里直接读页面源码。
  const page = readFileSync(
    resolve(__dirname, "../../app/ai-interview/view/page.tsx"),
    "utf8",
  );

  const usedMoreThanOnce = (sym: string) =>
    (page.match(new RegExp(sym.replace(/[$]/g, "\\$"), "g")) || []).length > 1;

  it("isStale 被调用 —— 否则刚打开页面时,几小时前的死帧会显示成「进行中」", () => {
    expect(usedMoreThanOnce("isStale")).toBe(true);
    // 旧的本地实现必须消失,不能两套并存
    expect(page).not.toMatch(/now - receivedAt > STALE_MS/);
  });

  it("reconnectDelayMs 被调用 —— 否则 403 是终态,手机永远停在「未配对」", () => {
    expect(usedMoreThanOnce("reconnectDelayMs")).toBe(true);
    expect(page).not.toMatch(/Math\.min\(1_000 \* 2 \*\* \(attempt - 1\), 8_000\)/);
  });

  it("命令请求带了超时 —— 否则按钮会永久变灰", () => {
    expect(usedMoreThanOnce("COMMAND_TIMEOUT_MS")).toBe(true);
    expect(page).toMatch(/AbortSignal\.timeout\(COMMAND_TIMEOUT_MS\)/);
  });
});
