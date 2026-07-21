import { describe, expect, it } from "vitest";

import {
  type EngageAutoConfig,
  type EngageAutoDeps,
  readAutoConfig,
  runEngageAuto,
} from "./engageAuto";

// —— readAutoConfig ——
describe("readAutoConfig", () => {
  it("空环境 → 安全默认值（总开关关、10 篇、24h、都点赞）", () => {
    const c = readAutoConfig({});
    expect(c.enabled).toBe(false);
    expect(c.count).toBe(10);
    expect(c.pages).toBe(2);
    expect(c.minIntervalSec).toBe(4);
    expect(c.maxIntervalSec).toBe(15);
    expect(c.intervalHours).toBe(24);
    expect(c.likeComment).toBe(true);
    expect(c.likeNote).toBe(true);
    expect(c.dryRun).toBe(false);
  });

  it("总开关只认真值；数量/翻页 clamp 到上限", () => {
    expect(readAutoConfig({ ENGAGE_AUTO_ENABLED: "1" }).enabled).toBe(true);
    expect(readAutoConfig({ ENGAGE_AUTO_ENABLED: "true" }).enabled).toBe(true);
    expect(readAutoConfig({ ENGAGE_AUTO_ENABLED: "0" }).enabled).toBe(false);
    expect(readAutoConfig({ ENGAGE_AUTO_ENABLED: "no" }).enabled).toBe(false);
    expect(readAutoConfig({ ENGAGE_AUTO_COUNT: "999" }).count).toBe(20); // MAX_NOTES
    expect(readAutoConfig({ ENGAGE_AUTO_COUNT: "0" }).count).toBe(1);
    expect(readAutoConfig({ ENGAGE_AUTO_PAGES: "99" }).pages).toBe(3); // MAX_PAGES
  });

  it("max 间隔不小于 min", () => {
    const c = readAutoConfig({ ENGAGE_AUTO_MIN_INTERVAL_SEC: "30", ENGAGE_AUTO_MAX_INTERVAL_SEC: "5" });
    expect(c.minIntervalSec).toBe(30);
    expect(c.maxIntervalSec).toBe(30);
  });

  it("点赞开关可关闭；styleHint 截断到 200", () => {
    const c = readAutoConfig({
      ENGAGE_AUTO_LIKE_COMMENT: "0",
      ENGAGE_AUTO_LIKE_NOTE: "off",
      ENGAGE_AUTO_STYLE_HINT: "风".repeat(500),
    });
    expect(c.likeComment).toBe(false);
    expect(c.likeNote).toBe(false);
    expect(c.styleHint.length).toBe(200);
  });
});

// —— runEngageAuto ——
type Posted = { noteId: string; content: string; andLike: boolean };

function makeCfg(over: Partial<EngageAutoConfig> = {}): EngageAutoConfig {
  return {
    enabled: true,
    count: 10,
    pages: 2,
    minIntervalSec: 0,
    maxIntervalSec: 0,
    intervalHours: 24,
    likeComment: true,
    likeNote: true,
    styleHint: "",
    dryRun: false,
    ...over,
  };
}

function makeDeps(over: Partial<EngageAutoDeps> = {}) {
  const posted: Posted[] = [];
  const marked: string[] = [];
  const likedNotes: string[] = [];
  const recorded: number[] = [];
  const base: EngageAutoDeps = {
    now: () => 1_000_000_000_000,
    rand: () => 0.5,
    sleep: async () => {},
    fetchHomefeed: async () => ({
      ok: true,
      notes: [
        { id: "n1", xsec_token: "t1", title: "笔记一" },
        { id: "n2", xsec_token: "t2", title: "笔记二" },
        { id: "n3", xsec_token: "t3", title: "笔记三" },
        { id: "noToken", title: "无令牌会被过滤" }, // 无 xsec_token → 过滤
      ],
    }),
    fetchNoteDetail: async (noteId) => ({ title: `详情-${noteId}`, desc: "足够长的正文内容用于生成评论", images: [] }),
    ocrImages: async () => "",
    generateComment: async (note) => `很棒的${note.title ?? ""}`,
    getCommentedNoteIds: async () => new Set<string>(),
    markCommented: async (o) => {
      marked.push(o.noteId);
    },
    postComment: async (noteId, content, andLike) => {
      posted.push({ noteId, content, andLike });
      return { ok: true, comment_id: `c-${noteId}`, like: { ok: true } };
    },
    likeNote: async (noteId) => {
      likedNotes.push(noteId);
      return { ok: true };
    },
    getLastAutoRunAt: async () => null,
    recordAutoRun: async (n) => {
      recorded.push(n);
    },
    ...over,
  };
  return { deps: base, posted, marked, likedNotes, recorded };
}

describe("runEngageAuto", () => {
  it("24h 闸门未到 → 跳过，不发不记录", async () => {
    const { deps, posted, recorded } = makeDeps({
      now: () => 1_000_000_000_000,
      getLastAutoRunAt: async () => 1_000_000_000_000 - 3_600_000, // 1 小时前
    });
    const r = await runEngageAuto(makeCfg(), () => {}, deps);
    expect(r.ran).toBe(false);
    expect(r.skipped).toContain("<24h");
    expect(posted.length).toBe(0);
    expect(recorded.length).toBe(0);
  });

  it("过了 24h → 发布、点赞、记去重库、记录成功时间点", async () => {
    const { deps, posted, marked, likedNotes, recorded } = makeDeps({
      getLastAutoRunAt: async () => 1_000_000_000_000 - 25 * 3_600_000,
    });
    const r = await runEngageAuto(makeCfg(), () => {}, deps);
    expect(r.ran).toBe(true);
    expect(r.posted).toBe(3); // n1,n2,n3（noToken 被过滤）
    expect(posted.map((p) => p.noteId)).toEqual(["n1", "n2", "n3"]);
    expect(posted.every((p) => p.andLike)).toBe(true); // likeComment → and_like=1
    expect(likedNotes).toEqual(["n1", "n2", "n3"]); // likeNote
    expect(marked).toEqual(["n1", "n2", "n3"]); // 去重库
    expect(recorded.length).toBe(1);
    expect(r.recorded).toBe(true);
  });

  it("count 限制 + 已评论去重", async () => {
    const { deps, posted } = makeDeps({
      getCommentedNoteIds: async () => new Set(["n1"]), // n1 已评论
    });
    const r = await runEngageAuto(makeCfg({ count: 1 }), () => {}, deps);
    expect(posted.map((p) => p.noteId)).toEqual(["n2"]); // 跳过 n1，取前 1 篇 = n2
    expect(r.posted).toBe(1);
    expect(r.fresh).toBe(1);
  });

  it("dry-run → 生成但绝不发布/点赞/记录", async () => {
    const { deps, posted, marked, recorded } = makeDeps();
    const r = await runEngageAuto(makeCfg({ dryRun: true }), () => {}, deps);
    expect(r.dryRun).toBe(true);
    expect(posted.length).toBe(0);
    expect(marked.length).toBe(0);
    expect(recorded.length).toBe(0);
    expect(r.posted).toBe(3); // 「本应发布」计数
  });

  it("推荐流取失败 → 跳过且不记录（环境坏，稍后重试）", async () => {
    const { deps, posted, recorded } = makeDeps({
      fetchHomefeed: async () => ({ ok: false, notes: [], error: "web_session 缺失" }),
    });
    const r = await runEngageAuto(makeCfg(), () => {}, deps);
    expect(r.ran).toBe(false);
    expect(r.skipped).toContain("取推荐流失败");
    expect(posted.length).toBe(0);
    expect(recorded.length).toBe(0);
  });

  it("发评论无响应(unknown) → 不记去重库，但仍记录成功时间点（已动手，避免 1h 后重复）", async () => {
    const { deps, marked, recorded } = makeDeps({
      postComment: async () => null, // 无响应
    });
    const r = await runEngageAuto(makeCfg({ count: 1 }), () => {}, deps);
    expect(r.unknown).toBe(1);
    expect(r.posted).toBe(0);
    expect(marked.length).toBe(0); // 未确认成功 → 不写去重库
    expect(recorded.length).toBe(1); // attempted>=1 → 记录，24h 内不再来
    expect(r.recorded).toBe(true);
  });

  it("没有新笔记 → 跳过，不记录", async () => {
    const { deps, recorded } = makeDeps({
      getCommentedNoteIds: async () => new Set(["n1", "n2", "n3"]),
    });
    const r = await runEngageAuto(makeCfg(), () => {}, deps);
    expect(r.ran).toBe(false);
    expect(r.skipped).toContain("没有新的可评论笔记");
    expect(recorded.length).toBe(0);
  });
});
