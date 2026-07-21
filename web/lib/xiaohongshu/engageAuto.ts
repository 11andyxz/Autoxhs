/**
 * 「每天自动评论」的无人值守编排（供本地 launchd 定时脚本调用，见 scripts/engageAuto.ts）。
 *
 * 一次运行做的事：
 *   1) 24h 滚动闸门：距上次成功 < N 小时就跳过（不发、不记录）。
 *   2) 取推荐信息流的候选笔记 → 去掉「已评论过」的（去重库）→ 取前 count 篇。
 *   3) 逐篇：读正文(必要时 OCR) → AI 生成「正向且相关」评论 → 真实发评论 + 可选点赞 → 记入去重库。
 *      串行 + 每篇随机间隔，降低风控概率。
 *   4) 只要「真的发起过评论请求」就把成功时间点写回（UPSERT 覆盖），24h 内不再重复。
 *
 * 安全：这是**真实、不可撤销**的写操作。总开关 ENGAGE_AUTO_ENABLED 默认关；--dry-run 只生成不发布。
 * 与网页版「互动助手」共用同一套评论生成(COMMENT_SYSTEM_PROMPT)与去重库(xhs_commented_notes)。
 */
import { generateComment, extractTextFromImages } from "@/lib/openai";
import { clampCommentLength } from "@/lib/xiaohongshu/comment";
import { MAX_NOTES, MAX_PAGES, MAX_STYLE_HINT } from "@/lib/xiaohongshu/engage";
import {
  getCommentedNoteIds,
  getLastAutoRunAt,
  markCommented,
  recordAutoRun,
} from "@/lib/xiaohongshu/engageDb";
import { buildNoteUrl } from "@/lib/xiaohongshu/url";

const BASE = (): string => process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";
const FEED_TIMEOUT_MS = 60_000;
const DETAIL_TIMEOUT_MS = 40_000;
const ACTION_TIMEOUT_MS = 45_000;
const OCR_MAX_IMAGES = 4;
const OCR_TIMEOUT_MS = 30_000;
/** 正文+标题不足这么多字 → 认为内容主要在图里，触发 OCR 补充相关性（与网页版一致）。 */
const MIN_TEXT_CHARS_FOR_OCR = 40;

export type Logger = (message: string) => void;

// —— 配置（全部来自环境变量，带安全默认值）——
export type EngageAutoConfig = {
  enabled: boolean;
  count: number;
  pages: number;
  minIntervalSec: number;
  maxIntervalSec: number;
  intervalHours: number;
  likeComment: boolean;
  likeNote: boolean;
  styleHint: string;
  dryRun: boolean;
};

function clampInt(raw: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function parseBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw == null || raw.trim() === "") return dflt;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** 从环境变量读配置（clamp 到安全范围）。dryRun 由调用方（命令行参数）覆盖。 */
export function readAutoConfig(env: Record<string, string | undefined> = process.env): EngageAutoConfig {
  const minIntervalSec = clampInt(env.ENGAGE_AUTO_MIN_INTERVAL_SEC, 1, 600, 4);
  const maxIntervalSec = Math.max(
    minIntervalSec,
    clampInt(env.ENGAGE_AUTO_MAX_INTERVAL_SEC, 1, 600, 15),
  );
  return {
    enabled: parseBool(env.ENGAGE_AUTO_ENABLED, false),
    count: clampInt(env.ENGAGE_AUTO_COUNT, 1, MAX_NOTES, 10),
    pages: clampInt(env.ENGAGE_AUTO_PAGES, 1, MAX_PAGES, 2),
    minIntervalSec,
    maxIntervalSec,
    intervalHours: clampInt(env.ENGAGE_AUTO_INTERVAL_HOURS, 1, 168, 24),
    likeComment: parseBool(env.ENGAGE_AUTO_LIKE_COMMENT, true),
    likeNote: parseBool(env.ENGAGE_AUTO_LIKE_NOTE, true),
    styleHint: (env.ENGAGE_AUTO_STYLE_HINT ?? "").trim().slice(0, MAX_STYLE_HINT),
    dryRun: false,
  };
}

// —— rednote 本地服务的返回信封（与 app/api/xiaohongshu/engage/* 路由保持一致）——
type RawNote = { id?: string; xsec_token?: string; type?: string; title?: string; user?: string; liked?: string };
type FeedResult = { ok: boolean; notes: RawNote[]; error?: string; code?: number };
type NoteDetail = { title: string; desc: string; images: string[] };
type CommentResult = {
  ok?: boolean;
  comment_id?: string;
  code?: number | string;
  msg?: string;
  error?: string;
  post?: { ok?: boolean; comment_id?: string; code?: number | string; msg?: string; error?: string };
  like?: { ok?: boolean; skipped?: string };
};
type LikeNoteResult = { ok?: boolean; code?: number | string; msg?: string; error?: string };

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(path: string, payload: unknown, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// —— 可注入依赖（默认走真实实现；测试时可替换）——
export type EngageAutoDeps = {
  now: () => number;
  rand: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchHomefeed: (pages: number) => Promise<FeedResult>;
  fetchNoteDetail: (noteId: string, xsecToken: string) => Promise<NoteDetail | null>;
  ocrImages: (images: string[]) => Promise<string>;
  generateComment: (note: { title?: string; desc?: string }, styleHint: string, imageText: string) => Promise<string>;
  getCommentedNoteIds: (ids: string[]) => Promise<Set<string>>;
  markCommented: (opts: {
    noteId: string;
    url?: string;
    title?: string;
    comment?: string;
    likedComment?: boolean;
    likedNote?: boolean;
  }) => Promise<void>;
  postComment: (noteId: string, content: string, andLike: boolean) => Promise<CommentResult | null>;
  likeNote: (noteId: string) => Promise<LikeNoteResult | null>;
  getLastAutoRunAt: () => Promise<number | null>;
  recordAutoRun: (postedCount: number) => Promise<void>;
};

export function makeDefaultDeps(): EngageAutoDeps {
  return {
    now: () => Date.now(),
    rand: () => Math.random(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchHomefeed: async (pages) => {
      const url = `${BASE()}/rednote/homefeed?` + new URLSearchParams({ pages: String(pages) }).toString();
      const json = await getJson<{ ok?: boolean; notes?: RawNote[]; error?: string; code?: number }>(url, FEED_TIMEOUT_MS);
      if (!json) return { ok: false, notes: [], error: "本地 rednote 服务无响应" };
      return { ok: json.ok === true, notes: json.notes ?? [], error: json.error, code: json.code };
    },
    fetchNoteDetail: async (noteId, xsecToken) => {
      const url = `${BASE()}/rednote/note?` + new URLSearchParams({ note_id: noteId, xsec_token: xsecToken }).toString();
      const json = await getJson<{ ok?: boolean; detail?: { title?: string; desc?: string; images?: Array<{ url?: string }> } }>(
        url,
        DETAIL_TIMEOUT_MS,
      );
      if (!json?.ok || !json.detail) return null;
      const d = json.detail;
      const images = (d.images ?? [])
        .map((im) => im?.url)
        .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
      return { title: d.title ?? "", desc: d.desc ?? "", images };
    },
    ocrImages: async (images) => {
      if (!images.length) return "";
      try {
        return await extractTextFromImages(images, {
          maxImages: OCR_MAX_IMAGES,
          timeoutMs: OCR_TIMEOUT_MS,
          maxRetries: 0,
        });
      } catch {
        return "";
      }
    },
    generateComment: (note, styleHint, imageText) => generateComment(note, styleHint, imageText),
    getCommentedNoteIds: (ids) => getCommentedNoteIds(ids),
    markCommented: (opts) => markCommented(opts),
    postComment: (noteId, content, andLike) =>
      postJson<CommentResult>(`/rednote/comment${andLike ? "?and_like=1" : ""}`, { note_id: noteId, content }, ACTION_TIMEOUT_MS),
    likeNote: (noteId) => postJson<LikeNoteResult>("/rednote/like-note", { note_oid: noteId }, ACTION_TIMEOUT_MS),
    getLastAutoRunAt: () => getLastAutoRunAt(),
    recordAutoRun: (postedCount) => recordAutoRun(postedCount),
  };
}

export type EngageAutoResult = {
  ran: boolean;
  dryRun: boolean;
  skipped?: string;
  fetched: number;
  fresh: number;
  attempted: number;
  posted: number;
  failed: number;
  unknown: number;
  recorded: boolean;
};

/** 归一化候选笔记：只保留有 id + xsec_token 的，去重（同 id 只留一条）。 */
function normalizeNotes(raw: RawNote[]): Array<{ id: string; xsecToken: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; xsecToken: string; title: string }> = [];
  for (const n of raw) {
    const id = (n.id ?? "").trim();
    const xsecToken = (n.xsec_token ?? "").trim();
    if (!id || !xsecToken || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, xsecToken, title: (n.title ?? "").trim() });
  }
  return out;
}

/** 推荐流读取失败时，把底层报错翻成一句人话（用于日志）。 */
function friendlyFeedError(err?: string): string {
  const e = (err ?? "").trim();
  if (/web_session|登录|未登录|mnsv2|签名/i.test(e)) {
    return "本地浏览器当前不在已登录的小红书页面（AdsPower 里登录 xiaohongshu.com 后重试）";
  }
  if (/461|风控|频率|-510|300012/i.test(e)) return "被小红书限流(风控)，稍后再试";
  return e || "读取推荐流失败";
}

/**
 * 执行一次自动评论。返回本次运行的统计。log 用于把过程打到日志文件。
 * deps 默认走真实实现；单测可注入假依赖。
 */
export async function runEngageAuto(
  cfg: EngageAutoConfig,
  log: Logger = () => {},
  deps: EngageAutoDeps = makeDefaultDeps(),
): Promise<EngageAutoResult> {
  const base: EngageAutoResult = {
    ran: false,
    dryRun: cfg.dryRun,
    fetched: 0,
    fresh: 0,
    attempted: 0,
    posted: 0,
    failed: 0,
    unknown: 0,
    recorded: false,
  };

  // 1) 24h 闸门（dry-run 不受闸门限制，方便随时预览）
  if (!cfg.dryRun) {
    const last = await deps.getLastAutoRunAt();
    if (last != null) {
      const elapsedH = (deps.now() - last) / 3_600_000;
      if (elapsedH < cfg.intervalHours) {
        const skipped = `距上次成功仅 ${elapsedH.toFixed(1)}h（<${cfg.intervalHours}h），本次跳过`;
        log(skipped);
        return { ...base, skipped };
      }
      log(`距上次成功 ${elapsedH.toFixed(1)}h ≥ ${cfg.intervalHours}h，开始本轮。`);
    } else {
      log("尚无成功记录，首次运行。");
    }
  } else {
    log("【DRY-RUN】只生成不发布、不记录、不受 24h 闸门限制。");
  }

  // 2) 取推荐信息流
  log(`取推荐信息流（${cfg.pages} 页）…`);
  const feed = await deps.fetchHomefeed(cfg.pages);
  if (!feed.ok) {
    const skipped = `取推荐流失败：${friendlyFeedError(feed.error)}。不记录，稍后重试。`;
    log(skipped);
    return { ...base, skipped };
  }
  const notes = normalizeNotes(feed.notes);
  base.fetched = notes.length;
  log(`拿到 ${notes.length} 篇候选。`);
  if (!notes.length) {
    const skipped = "推荐流没有可用笔记，稍后重试。";
    log(skipped);
    return { ...base, skipped };
  }

  // 3) 去掉已评论过的，取前 count 篇
  let commented = new Set<string>();
  try {
    commented = await deps.getCommentedNoteIds(notes.map((n) => n.id));
  } catch (e) {
    log(`查去重库失败(降级为都未评论)：${(e as Error)?.name ?? "error"}`);
  }
  const fresh = notes.filter((n) => !commented.has(n.id)).slice(0, cfg.count);
  base.fresh = fresh.length;
  log(`去重后 ${fresh.length} 篇待处理（跳过 ${notes.length - fresh.length} 篇已评论/超额）。`);
  if (!fresh.length) {
    const skipped = "没有新的可评论笔记（可能都评论过了），稍后重试。";
    log(skipped);
    return { ...base, skipped };
  }

  // 4) 逐篇处理
  base.ran = true;
  for (let i = 0; i < fresh.length; i++) {
    const note = fresh[i];
    const tag = `[${i + 1}/${fresh.length}]`;

    // 读正文（保证「相关」）；正文太短且有图 → OCR 补充
    const detail = await deps.fetchNoteDetail(note.id, note.xsecToken);
    const title = (detail?.title || note.title).trim();
    const desc = (detail?.desc || "").trim();
    const images = detail?.images ?? [];
    let imageText = "";
    if ((title + desc).length < MIN_TEXT_CHARS_FOR_OCR && images.length) {
      imageText = await deps.ocrImages(images);
    }
    if (!title && !desc && !imageText) {
      log(`${tag} 读不到内容，跳过（${note.id}）。`);
      continue;
    }

    // 生成评论
    let comment: string;
    try {
      comment = clampCommentLength((await deps.generateComment({ title, desc }, cfg.styleHint, imageText)).trim());
    } catch (e) {
      log(`${tag} 生成评论失败，跳过：${(e as Error)?.message ?? "error"}`);
      continue;
    }
    if (!comment) {
      log(`${tag} 生成结果为空，跳过。`);
      continue;
    }

    const label = title ? `《${title.slice(0, 24)}》` : note.id;

    if (cfg.dryRun) {
      log(`${tag} 【DRY】${label} → 「${comment}」`);
      base.attempted += 1;
      base.posted += 1; // 记为「本应发布」，dry-run 不真实发
      if (i < fresh.length - 1) await deps.sleep(1000);
      continue;
    }

    // 真实发评论（单次、不重试，避免重复写）
    base.attempted += 1;
    const cr = await deps.postComment(note.id, comment, cfg.likeComment);
    if (cr === null) {
      // 无响应：评论可能已发也可能没发。绝不本轮重试；也不记去重库（execute 路由同策略）。
      base.unknown += 1;
      log(`${tag} ⚠️ 无响应，无法确认是否已发，不重试（${note.id}）。`);
    } else {
      const commentPosted = cr.post ? cr.post.ok === true : cr.ok === true;
      if (commentPosted) {
        base.posted += 1;
        const commentLiked = cfg.likeComment ? cr.like?.ok === true : false;
        let noteLiked = false;
        if (cfg.likeNote) {
          const lr = await deps.likeNote(note.id);
          noteLiked = lr?.ok === true;
        }
        // 记入去重库（best-effort：失败不影响本次结果，只是下次可能重复）
        try {
          await deps.markCommented({
            noteId: note.id,
            url: buildNoteUrl(note.id, note.xsecToken),
            title,
            comment,
            likedComment: commentLiked,
            likedNote: noteLiked,
          });
        } catch (e) {
          log(`${tag} 记去重库失败(忽略)：${(e as Error)?.name ?? "error"}`);
        }
        log(`${tag} ✅ 已评论 ${label} → 「${comment}」${commentLiked ? " 👍" : ""}${noteLiked ? " ❤️" : ""}`);
      } else {
        base.failed += 1;
        const why = cr.post?.msg || cr.post?.error || cr.msg || cr.error || "被拒绝(可能限流)";
        log(`${tag} ❌ 发评论失败：${why}`);
      }
    }

    // 每篇之间随机间隔（最后一篇不等）
    if (i < fresh.length - 1) {
      const span = cfg.maxIntervalSec - cfg.minIntervalSec;
      const waitSec = cfg.minIntervalSec + Math.round(deps.rand() * span);
      log(`${tag} 间隔 ${waitSec}s…`);
      await deps.sleep(waitSec * 1000);
    }
  }

  // 5) 只要真的发起过评论请求就记录成功时间点（含 unknown/rejected：都算「今天动过手」，
  //    避免 1 小时后又来一轮造成重复/加剧风控）。环境坏在前面已 return，不会走到这里。
  if (!cfg.dryRun && base.attempted >= 1) {
    try {
      await deps.recordAutoRun(base.posted);
      base.recorded = true;
      log(`已记录本次成功时间点（发出 ${base.posted} 条）；${cfg.intervalHours}h 内不再运行。`);
    } catch (e) {
      log(`记录成功时间点失败：${(e as Error)?.message ?? "error"}（下次可能提前重跑）`);
    }
  }

  log(
    `本轮结束：发出 ${base.posted} · 失败 ${base.failed} · 未知 ${base.unknown} · 尝试 ${base.attempted} · 待处理 ${base.fresh}。`,
  );
  return base;
}
