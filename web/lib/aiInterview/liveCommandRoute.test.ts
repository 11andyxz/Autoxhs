import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/ai-interview/live/command/route";
import { drainLiveCommands, liveCode } from "./liveHub";

/**
 * 手机 → 桌面端的命令入口。
 *
 * 这条路由在公网隧道的白名单里(手机要能从任何网络点按钮),而它排出去的每一条
 * 都会在 Mac 上变成一次合成按键。所以它是整套东西里唯一「外网可达 + 能让本机动作」
 * 的接口 —— 输入校验的顺序和严格程度都要按这个来看。
 */

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost:3100/api/ai-interview/live/command", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never);

describe("命令入口", () => {
  it("配对码对 + 动作在白名单 → 排队", async () => {
    drainLiveCommands();
    const res = await post({ k: liveCode(), type: "whatToAnswer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(drainLiveCommands().map((c) => c.type)).toEqual(["whatToAnswer"]);
  });

  it("没有配对码 / 码不对 → 403,且什么都不排队", async () => {
    drainLiveCommands();
    for (const k of [undefined, null, "", "wrong1", 12345, liveCode().toUpperCase()]) {
      const res = await post({ k, type: "whatToAnswer" });
      expect(res.status).toBe(403);
    }
    expect(drainLiveCommands()).toEqual([]);
  });

  it("白名单之外的动作一律拒绝", async () => {
    drainLiveCommands();
    for (const type of ["quitApp", "rm -rf /", "", "__proto__", "constructor", "toString"]) {
      const res = await post({ k: liveCode(), type });
      expect(res.status).toBe(400);
    }
    expect(drainLiveCommands()).toEqual([]);
  });

  it("继承来的 type 不算 —— 必须是自有属性", async () => {
    drainLiveCommands();
    // JSON 里的 "__proto__" 经 JSON.parse 是普通自有属性,不会污染原型;
    // 这里验的是判据本身不接受非自有/非字符串。
    const res = await post({ k: liveCode(), type: { toString: () => "whatToAnswer" } });
    expect(res.status).toBe(400);
    expect(drainLiveCommands()).toEqual([]);
  });

  it("巨大的 body 在解析之前就被拒,而且没有配对码更不该先读它", async () => {
    drainLiveCommands();
    const huge = JSON.stringify({ k: "wrong1", type: "whatToAnswer", pad: "x".repeat(100_000) });
    const res = await post(huge, { "content-length": String(huge.length) });
    expect(res.status).toBe(413);
    expect(drainLiveCommands()).toEqual([]);
  });

  it("坏 JSON 不会 500", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  it("body 是数组 / 字符串 / null 都被拒", async () => {
    for (const body of [[], "just a string", null, 42]) {
      const res = await post(body);
      expect([400, 403]).toContain(res.status);
    }
  });
});
