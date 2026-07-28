"use client";

import { useRef, useState } from "react";

import { CTA_LINE } from "@/lib/schema";
import { collapseBlankLines, pickCharsPerCard } from "@/lib/xiaohongshu/cards";
import { PALETTES, STYLES } from "@/lib/xiaohongshu/cards/tokens";
import type { CardOutline, PaletteId, StyleId } from "@/lib/xiaohongshu/cards/types";
import { buildDesc } from "@/lib/xiaohongshu/publishBody";
import { parseNoteId } from "@/lib/xiaohongshu/url";
import type { RewriteData } from "@/lib/schema";

const MAX_LINKS = 10;
/** 设计卡片右下角水印，与单条页保持一致 */
const CARD_WATERMARK = "@北美熊哥聊求职";
// 准备阶段（导入→OCR→优化→拆卡）的并发度。导入会在本地 rednote 服务串行排队，但都很快；
// OCR/优化/拆卡走 OpenAI 可并行（rewrite 每 IP 限流 10/分钟，单批 ≤10 条不会触顶）。
const PREP_CONCURRENCY = 4;

const STYLE_OPTIONS: Array<[StyleId | "auto", string]> = [
  ["auto", "自动选"],
  ...(Object.entries(STYLES) as Array<[StyleId, { name: string }]>).map(
    ([id, s]) => [id, s.name] as [StyleId, string],
  ),
];

const PALETTE_OPTIONS: Array<[PaletteId | "auto", string]> = [
  ["auto", "自动选"],
  ["default", "风格自带"],
  ...(Object.entries(PALETTES) as Array<[Exclude<PaletteId, "default">, { name: string }]>).map(
    ([id, p]) => [id, p.name] as [PaletteId, string],
  ),
];

type Status =
  | "queued"
  | "importing"
  | "ocr"
  | "rewriting"
  | "covering"
  | "outlining"
  | "prepared"
  | "rendering"
  | "uploading"
  | "publishing"
  | "done"
  | "failed"
  | "skipped";

type Item = {
  id: string;
  url: string;
  noteId: string;
  status: Status;
  title?: string;
  body?: string;
  tags?: string[];
  charsPerCard?: number;
  // 该条内容对应的 AI 配图候选 URL（准备阶段拉取），发布时按整批去重挑一张。
  coverCandidates?: string[];
  // 取配图被上游拦截(如账号风控 906)时的原因；有值说明该条会回落默认封面，需提示用户。
  coverReason?: string;
  // ---- 设计卡片模式专用 ----
  deckId?: string;
  outline?: CardOutline;
  /** 渲染时降到最小字号仍装不下的卡片序号（1 起） */
  overflow?: number[];
  shareLink?: string | null;
  error?: string;
  // 发布超时/未确认：rednote 可能其实已发布成功 → 重试前需二次确认，避免重复公开。
  ambiguous?: boolean;
  /** 发布后回报的落地情况：真正写进笔记的话题、被丢掉的标签、是否声明了原创（都改不了了） */
  published?: { tags: string[]; missingTags: string[]; original: boolean };
};

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-gray-100 text-gray-500" },
  importing: { label: "导入中…", cls: "bg-sky-50 text-sky-600" },
  ocr: { label: "识别图片中…", cls: "bg-sky-50 text-sky-600" },
  rewriting: { label: "AI 优化中…", cls: "bg-sky-50 text-sky-600" },
  covering: { label: "选配图中…", cls: "bg-sky-50 text-sky-600" },
  outlining: { label: "拆卡中…", cls: "bg-sky-50 text-sky-600" },
  prepared: { label: "待发布", cls: "bg-amber-50 text-amber-700" },
  rendering: { label: "渲染卡片中…", cls: "bg-amber-50 text-amber-700" },
  uploading: { label: "上传卡片中…", cls: "bg-amber-50 text-amber-700" },
  publishing: { label: "发布中…", cls: "bg-amber-50 text-amber-700" },
  done: { label: "✅ 已发布", cls: "bg-emerald-50 text-emerald-700" },
  failed: { label: "❌ 失败", cls: "bg-red-50 text-red-600" },
  skipped: { label: "⏭️ 已跳过（之前已发布）", cls: "bg-gray-100 text-gray-500" },
};

type CheckResult = { url: string; noteId: string | null; done: boolean };

/** 解析输入：按行拆，保留含 note_id 的小红书链接，按 note_id 去重；返回去重后的项与被忽略行数。 */
function parseInput(text: string): { items: Array<{ url: string; noteId: string }>; ignored: number } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const items: Array<{ url: string; noteId: string }> = [];
  let ignored = 0;
  for (const line of lines) {
    const noteId = parseNoteId(line);
    if (!noteId) {
      ignored += 1;
      continue;
    }
    if (seen.has(noteId)) continue; // 同一批内重复的同一篇只留一条
    seen.add(noteId);
    items.push({ url: line, noteId });
  }
  return { items, ignored };
}

export default function BatchPublish() {
  const [linksText, setLinksText] = useState("");
  // 总开关：打开后整批走「设计卡片」（本地渲染的图文卡），关闭则是原来的长文文字卡。
  const [useCards, setUseCards] = useState(false);
  // 整批是否声明原创。只能在发布那一刻写进 business_binds，发完补不了。
  const [declareOriginal, setDeclareOriginal] = useState(true);
  const [cardStyle, setCardStyle] = useState<StyleId | "auto">("auto");
  const [cardPalette, setCardPalette] = useState<PaletteId | "auto">("auto");
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dedupWarning, setDedupWarning] = useState<string | null>(null);
  // 本次会话已成功发布（或被服务端幂等跳过）的 note_id：即使去重库暂时不可用，也据此防止重复公开。
  const postedRef = useRef<Set<string>>(new Set());
  // 本批已分配出去的 AI 封面 URL：用于让各条尽量挑不同的封面（候选用尽时才允许重复）。
  const usedCoversRef = useRef<Set<string>>(new Set());

  const parsed = parseInput(linksText);
  const overLimit = parsed.items.length > MAX_LINKS;

  function patch(id: string, next: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));
  }

  // 准备：导入 → (有图)OCR 合并 → AI 优化；成功后置为 prepared，失败抛出错误信息。
  async function prepare(item: Item): Promise<void> {
    patch(item.id, { status: "importing", error: undefined });
    const imp = await fetch("/api/xiaohongshu/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url }),
    });
    const impJson = (await imp.json().catch(() => null)) as
      | { success: boolean; data?: { title?: string; desc?: string; images?: string[] }; error?: string }
      | null;
    if (!impJson?.success || !impJson.data) {
      throw new Error(impJson?.error ?? "导入失败（确认本地 rednote 服务在运行且浏览器已登录）。");
    }
    const { title, desc, images } = impJson.data;
    let content = [title, desc].filter(Boolean).join("\n\n").trim();

    if (images && images.length > 0) {
      patch(item.id, { status: "ocr" });
      try {
        const ocr = await fetch("/api/xiaohongshu/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrls: images }),
        });
        const ocrJson = (await ocr.json().catch(() => null)) as
          | { success: boolean; text?: string }
          | null;
        if (ocrJson?.success && ocrJson.text) {
          content = content
            ? `${content}\n\n【图片文字】\n${ocrJson.text}`
            : (ocrJson.text as string);
        }
      } catch {
        // OCR 失败不致命：用已有文字继续优化
      }
    }

    content = content.slice(0, 10_000).trim();
    if (!content) {
      throw new Error("这篇笔记没有可用文字（正文为空且未识别到图片文字）。");
    }

    patch(item.id, { status: "rewriting" });
    const rw = await fetch("/api/xiaohongshu/rewrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const rwJson = (await rw.json().catch(() => null)) as
      | { success: boolean; data?: RewriteData; error?: string }
      | null;
    if (!rwJson?.success || !rwJson.data) {
      throw new Error(rwJson?.error ?? "AI 优化失败，请稍后重试。");
    }
    const data = rwJson.data;
    const chosenTitle = data.titles[0]?.text?.trim() ?? "";
    const body = collapseBlankLines(data.body);
    if (!chosenTitle || !body) {
      throw new Error("AI 未生成有效的标题或正文。");
    }

    // 设计卡片模式：不需要 AI 配图（整叠都是本地渲染的自制卡），改成拆卡。
    // 顺带完全不碰 /cover_images —— 906 风控那条路径压根不会被触发。
    if (useCards) {
      patch(item.id, { status: "outlining" });
      const ol = await fetch("/api/xiaohongshu/cards/outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: chosenTitle,
          body,
          tags: data.tags,
          style: cardStyle,
          palette: cardPalette,
          cardCount: "auto",
          watermark: CARD_WATERMARK,
        }),
      });
      const olJson = (await ol.json().catch(() => null)) as
        | { success: boolean; deckId?: string; outline?: CardOutline; error?: string }
        | null;
      if (!olJson?.success || !olJson.deckId || !olJson.outline) {
        throw new Error(olJson?.error ?? "拆卡失败，请稍后重试。");
      }
      patch(item.id, {
        status: "prepared",
        title: chosenTitle,
        body,
        tags: data.tags,
        deckId: olJson.deckId,
        outline: olJson.outline,
      });
      return;
    }

    // 取该条内容的 AI 配图候选（best-effort：失败/超时则该条无候选，发布时按兜底借用其它条的封面）。
    patch(item.id, { status: "covering" });
    let coverCandidates: string[] = [];
    let coverReason: string | undefined;
    try {
      const cv = await fetch("/api/xiaohongshu/cover-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: `${chosenTitle}\n\n${body}`.slice(0, 2000) }),
      });
      const cj = (await cv.json().catch(() => null)) as
        | { success: boolean; images?: string[]; blocked?: boolean; reason?: string }
        | null;
      if (cj?.success && Array.isArray(cj.images)) {
        coverCandidates = cj.images.filter((u): u is string => typeof u === "string" && !!u);
      }
      // 上游明确拦截(如账号风控)且无候选：记下原因，本条发布会回落默认封面。
      if (coverCandidates.length === 0 && cj?.blocked && cj.reason) coverReason = cj.reason;
    } catch {
      // 拉配图失败不致命：该条发布时按兜底处理
    }

    patch(item.id, {
      status: "prepared",
      title: chosenTitle,
      body,
      tags: data.tags,
      charsPerCard: pickCharsPerCard(body),
      coverCandidates,
      coverReason,
    });
  }

  // 为某条挑一张 AI 封面：优先用它自己候选里本批还没用过的；自己候选都用过了就用自己的第一张；
  // 自己完全没有候选时，借用本批其它条用过的封面（允许重复）；整批都没有候选时返回 undefined（默认封面）。
  function assignCover(item: Item): string | undefined {
    const candidates = item.coverCandidates ?? [];
    const used = usedCoversRef.current;
    let chosen = candidates.find((c) => !used.has(c)) ?? candidates[0];
    if (!chosen && used.size > 0) {
      chosen = Array.from(used)[0]; // 没有自己的候选 → 复用其它条的封面
    }
    if (chosen) used.add(chosen);
    return chosen;
  }

  /**
   * 设计卡片模式的出图：渲染整叠 → 串行上传拿 file_id。
   * 这两步都发生在「真实发布」之前，所以失败可以放心重试，不存在重复公开的风险。
   * 渲染放在这里（而不是并发的准备阶段）是因为每次渲染都要起一个 Chrome，
   * 并发 4 个太重；顺序跑一条约 3 秒，10 条也就多半分钟。
   */
  async function renderAndUpload(
    item: Item,
  ): Promise<{ fileIds: string[]; width: number; height: number }> {
    if (!item.deckId || !item.outline) throw new Error("这条还没拆卡，无法生成卡片。");

    patch(item.id, { status: "rendering" });
    const rd = await fetch("/api/xiaohongshu/cards/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckId: item.deckId, outline: item.outline }),
    });
    const rdJson = (await rd.json().catch(() => null)) as
      | {
          success: boolean;
          count?: number;
          overflow?: number[];
          width?: number;
          height?: number;
          error?: string;
        }
      | null;
    if (!rdJson?.success || !rdJson.count) {
      throw new Error(rdJson?.error ?? "卡片渲染失败。");
    }
    // 无条件覆盖（含清空）：重渲后如果不再溢出，旧的提示必须消失
    patch(item.id, { overflow: rdJson.overflow ?? [] });

    patch(item.id, { status: "uploading" });
    const ids: string[] = [];
    for (let i = 1; i <= rdJson.count; i += 1) {
      const up = await fetch("/api/xiaohongshu/cards/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId: item.deckId, index: i }),
      });
      const upJson = (await up.json().catch(() => null)) as
        | { success: boolean; fileId?: string; error?: string }
        | null;
      if (!upJson?.success || !upJson.fileId) {
        throw new Error(upJson?.error ?? `第 ${i} 张卡片上传失败。`);
      }
      ids.push(upJson.fileId);
    }
    // 尺寸由渲染层回报、原样上报给小红书，避免改了出图尺寸后这里对不上
    return { fileIds: ids, width: rdJson.width ?? 0, height: rdJson.height ?? 0 };
  }

  // 发布：默认公开（privacy=0）、带 sourceUrl 记入去重库，并带 skipIfPublished 让服务端做
  // 发布前幂等检查。自包含处理状态（不抛错给调用方）。
  // 设计卡片模式走 /publish-images（整叠自制图）；否则走 /publish（长文文字卡 + AI 封面）。
  async function publish(item: Item): Promise<void> {
    if (!item.title || !item.body) {
      patch(item.id, { status: "failed", error: "缺少标题或正文，无法发布。" });
      return;
    }

    let cards: { fileIds: string[]; width: number; height: number } | null = null;
    if (useCards) {
      try {
        cards = await renderAndUpload(item);
      } catch (e) {
        // 还没走到发布这一步，重试是安全的（不标 ambiguous）
        patch(item.id, { status: "failed", error: (e as Error)?.message ?? "卡片生成失败。" });
        return;
      }
    }

    patch(item.id, { status: "publishing", error: undefined, ambiguous: false });

    const coverImage = useCards ? undefined : assignCover(item);
    const endpoint = useCards
      ? "/api/xiaohongshu/publish-images"
      : "/api/xiaohongshu/publish";
    const payload = useCards
      ? {
          title: item.title,
          body: item.body,
          tags: item.tags ?? [],
          fileIds: cards?.fileIds ?? [],
          width: cards?.width,
          height: cards?.height,
          confirm: true,
          privacy: 0,
          original: declareOriginal,
          sourceUrl: item.url,
          skipIfPublished: true,
        }
      : {
          title: item.title,
          body: item.body,
          tags: item.tags ?? [],
          confirm: true,
          charsPerCard: item.charsPerCard,
          coverImage: coverImage || undefined,
          privacy: 0,
          original: declareOriginal,
          sourceUrl: item.url,
          skipIfPublished: true,
        };

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // 网络层中断：rednote 可能已发布、结果未知 → 标记疑似已发布，重试需确认。
      patch(item.id, {
        status: "failed",
        ambiguous: true,
        error: "发布请求中断，结果未知；请到小红书确认后再决定是否重试。",
      });
      return;
    }

    const json = (await res.json().catch(() => null)) as
      | {
          success: boolean;
          published?: boolean;
          skipped?: boolean;
          shareLink?: string | null;
          dedupRecorded?: boolean;
          tags?: string[];
          missingTags?: string[];
          original?: boolean;
          error?: string;
        }
      | null;

    // 命中服务端幂等保护：之前已发布过 → 跳过，不重复公开。
    if (json?.success && json.skipped) {
      postedRef.current.add(item.noteId);
      patch(item.id, { status: "skipped", error: undefined, ambiguous: false });
      return;
    }
    if (!json?.success || !json.published) {
      const msg = json?.error ?? "发布失败，请稍后重试。";
      // 超时/未确认类失败：rednote 可能其实已发布 → 标记疑似，重试需确认。
      const ambiguous = /超时|timeout|未确认/i.test(msg);
      patch(item.id, {
        status: "failed",
        ambiguous,
        error: ambiguous ? `${msg}（可能已发布，重试前请到小红书确认）` : msg,
      });
      return;
    }

    postedRef.current.add(item.noteId);
    patch(item.id, {
      status: "done",
      shareLink: json.shareLink ?? null,
      ambiguous: false,
      // 话题与原创发布后就定死了，把实际落地情况留在卡片上（不是错误，单独一行提示）
      published: {
        tags: json.tags ?? [],
        missingTags: json.missingTags ?? [],
        original: json.original === true,
      },
      // 发布成功但去重库没写进去：提醒用户，重复粘贴该链接可能会再次发布。
      error:
        json.dedupRecorded === false
          ? "已发布，但未能写入去重库；重复粘贴此链接可能会再次发布。"
          : undefined,
    });
  }

  // 跑一个并发池：把 work 列表用 concurrency 个 worker 并发消费。
  async function runPool<T>(work: T[], concurrency: number, fn: (x: T) => Promise<void>) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < work.length) {
        const idx = cursor++;
        await fn(work[idx]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  }

  async function onStart() {
    if (running) return;
    setError(null);
    setNotice(null);
    setDedupWarning(null);
    usedCoversRef.current = new Set(); // 新一批：重置封面去重

    const { items: parsedItems, ignored } = parseInput(linksText);
    if (parsedItems.length === 0) {
      setError("请粘贴至少一个有效的小红书笔记链接（一行一个）。");
      return;
    }
    if (parsedItems.length > MAX_LINKS) {
      setError(`单批最多 ${MAX_LINKS} 条，当前 ${parsedItems.length} 条，请减少后重试。`);
      return;
    }

    const modeText = useCards
      ? "每条会拆成几张设计卡片（正文放在笔记正文里）"
      : "每条会把正文渲染成长文文字卡";
    if (
      !window.confirm(
        `将按「公开」发布 ${parsedItems.length} 条笔记到当前登录的小红书账号，${modeText}。发布后可在小红书端改可见性。确认继续？`,
      )
    ) {
      return;
    }

    setRunning(true);

    // 预筛：查去重库，已发布过的标记跳过。
    let doneSet = new Set<string>();
    try {
      const res = await fetch("/api/xiaohongshu/processed/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: parsedItems.map((i) => i.url) }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; results?: CheckResult[] }
        | null;
      if (json?.success && json.results) {
        doneSet = new Set(json.results.filter((r) => r.done && r.noteId).map((r) => r.noteId as string));
      } else {
        setDedupWarning(
          "去重库返回异常，无法自动跳过之前已发布过的笔记；请避免重复粘贴，以免重复公开。",
        );
      }
    } catch {
      // 去重库不可用时不阻断发布（避免数据库问题挡住主流程），但提醒用户重复粘贴有重发风险。
      setDedupWarning(
        "去重库不可用，无法自动跳过之前已发布过的笔记；请避免重复粘贴，以免重复公开。",
      );
    }
    // 叠加本次会话已发布过的 note_id：即便去重库不可用，也不会在同一会话里重复发布。
    for (const id of postedRef.current) doneSet.add(id);

    const initial: Item[] = parsedItems.map((i) => ({
      id: i.noteId,
      url: i.url,
      noteId: i.noteId,
      status: doneSet.has(i.noteId) ? "skipped" : "queued",
    }));
    setItems(initial);

    const skippedCount = initial.filter((i) => i.status === "skipped").length;
    const noticeParts: string[] = [];
    if (skippedCount) noticeParts.push(`跳过 ${skippedCount} 条（之前已发布）`);
    if (ignored) noticeParts.push(`忽略 ${ignored} 行无效链接`);
    setNotice(noticeParts.join("，") || null);

    const toProcess = initial.filter((i) => i.status !== "skipped");

    // 阶段一：并发准备（导入/识别/优化）。单条失败只标记该条。
    await runPool(toProcess, PREP_CONCURRENCY, async (item) => {
      try {
        await prepare(item);
      } catch (e) {
        patch(item.id, { status: "failed", error: (e as Error)?.message ?? "准备失败。" });
      }
    });

    // 阶段二：顺序发布（本地服务单线程串行；发布与导入共用同一把锁，故与准备阶段分离、逐条发）。
    // 用最新 state 里仍处于 prepared 的条目逐条发布。
    const prepared = await new Promise<Item[]>((resolve) => {
      setItems((prev) => {
        resolve(prev.filter((i) => i.status === "prepared"));
        return prev;
      });
    });
    for (const item of prepared) {
      try {
        await publish(item);
      } catch (e) {
        patch(item.id, { status: "failed", error: (e as Error)?.message ?? "发布失败。" });
      }
    }

    setRunning(false);
  }

  // 单条重试：失败的条目可单独重跑「准备 + 发布」（顺序执行，避免与其它发布抢本地服务锁）。
  // 多重防重发：① 会话内已发布过 → 跳过；② 疑似已发布(超时/未确认) → 二次确认；
  // ③ 重发前再查去重库，已记录则跳过；④ 服务端 publish 仍带 skipIfPublished 兜底。
  async function onRetry(id: string) {
    if (running) return;
    const item = items.find((i) => i.id === id);
    if (!item) return;

    if (postedRef.current.has(item.noteId)) {
      patch(id, { status: "skipped", error: "本次会话已发布过，已跳过。" });
      return;
    }
    if (
      item.ambiguous &&
      !window.confirm(
        "这条之前发布超时或结果未知，可能已经发布成功。仍要重新发布吗？这可能会产生重复的公开笔记。",
      )
    ) {
      return;
    }

    setRunning(true);
    try {
      // 重发前再查一次去重库；已记录则跳过（查不到就靠服务端 skipIfPublished 兜底）。
      try {
        const res = await fetch("/api/xiaohongshu/processed/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: [item.url] }),
        });
        const json = (await res.json().catch(() => null)) as
          | { success: boolean; results?: CheckResult[] }
          | null;
        if (json?.success && json.results?.[0]?.done) {
          patch(id, { status: "skipped", error: "该笔记已发布过，已跳过。" });
          return;
        }
      } catch {
        // 查不到就继续，由服务端 skipIfPublished 做最后兜底
      }

      // 重试要从头来：把上一次的卡片产物（deckId/outline/溢出提示）一并清掉，
      // 否则 prepare 之前的空档里还挂着旧数据，UI 会显示上一版的张数与风格。
      const fresh: Item = {
        ...item,
        status: "queued",
        error: undefined,
        shareLink: undefined,
        ambiguous: false,
        published: undefined,
        deckId: undefined,
        outline: undefined,
        overflow: undefined,
      };
      patch(id, fresh);
      await prepare(fresh);
      // prepare 成功后该条已是 prepared；用最新字段发布
      const ready = await new Promise<Item | undefined>((resolve) => {
        setItems((prev) => {
          resolve(prev.find((i) => i.id === id));
          return prev;
        });
      });
      if (ready && ready.status === "prepared") await publish(ready);
    } catch (e) {
      patch(id, { status: "failed", error: (e as Error)?.message ?? "重试失败。" });
    } finally {
      setRunning(false);
    }
  }

  const summary = {
    total: items.length,
    done: items.filter((i) => i.status === "done").length,
    failed: items.filter((i) => i.status === "failed").length,
    skipped: items.filter((i) => i.status === "skipped").length,
  };
  // AI 配图被拦截提示：任一条在准备阶段被上游拒绝(如账号风控)，就横幅说明将回落默认封面。
  const coverBlockedReason = items.find((i) => i.coverReason)?.coverReason;
  const coverBlockedCount = items.filter((i) => i.coverReason).length;

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
      <div className="rounded-xl bg-rose-50/60 p-3">
        <p className="text-sm font-semibold text-gray-800">批量发布</p>
        <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
          一行粘贴一个小红书笔记链接（最多 {MAX_LINKS} 条）。每条自动：导入正文 → 识别图片文字 → AI 优化 →
          取第一个标题 →{" "}
          {useCards ? (
            <>
              拆成设计卡片 → <span className="font-medium text-gray-700">公开发布</span>（整叠自制图）。
            </>
          ) : (
            <>
              <span className="font-medium text-gray-700">公开发布</span>（长文文字卡 + AI 封面）。
            </>
          )}
          之前发布过的相同笔记会自动跳过。
        </p>
      </div>

      {/* 总开关：整批改用设计卡片。默认关闭 = 原来的行为。 */}
      <div className="mt-4 rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={useCards}
            onClick={() => setUseCards((v) => !v)}
            disabled={running}
            className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
              useCards ? "bg-xhs" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                useCards ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
          <span className="text-sm font-medium text-gray-800">用设计卡片发（整批）</span>
          {useCards && (
            <>
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                风格
                <select
                  value={cardStyle}
                  onChange={(e) => setCardStyle(e.target.value as StyleId | "auto")}
                  disabled={running}
                  className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm outline-none focus:border-xhs disabled:opacity-50"
                >
                  {STYLE_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                配色
                <select
                  value={cardPalette}
                  onChange={(e) => setCardPalette(e.target.value as PaletteId | "auto")}
                  disabled={running}
                  className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm outline-none focus:border-xhs disabled:opacity-50"
                >
                  {PALETTE_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
          {useCards
            ? "开：每条拆成 3~10 张本地渲染的设计卡（1440×1920），完整正文放在笔记正文里。不走小红书 AI 配图，因此不会碰到 906 风控；代价是每条多约 25 秒拆卡 + 3 秒渲染 + 逐张上传。风格选「自动选」时每条会按自己的内容各选各的。"
            : "关：沿用原来的长文文字卡 + AI 封面。"}
        </p>

        {/* 声明原创：整批统一。发布那一刻写进笔记，发完补不了。 */}
        <label className="mt-3 inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={declareOriginal}
            onChange={(e) => setDeclareOriginal(e.target.checked)}
            disabled={running}
            className="h-4 w-4 accent-xhs disabled:cursor-not-allowed"
          />
          <span className="text-sm text-gray-800">整批声明原创</span>
          <span className="text-[11px] text-gray-400">
            发布时写入，事后无法补声明；标签会自动查成可点击话题，查不到的会被丢弃。
          </span>
        </label>
      </div>

      <textarea
        value={linksText}
        onChange={(e) => setLinksText(e.target.value)}
        disabled={running}
        placeholder={"每行一个链接，例如：\nhttps://www.xiaohongshu.com/explore/xxxx?xsec_token=...\nhttps://www.xiaohongshu.com/explore/yyyy?xsec_token=..."}
        className="mt-4 min-h-[160px] w-full resize-y rounded-xl border border-gray-200 p-4 text-sm leading-relaxed outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40 disabled:bg-gray-50"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onStart}
          disabled={running || parsed.items.length === 0 || overLimit}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-6 py-3 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {running ? "批量处理中…" : `开始批量发布${parsed.items.length ? `（${parsed.items.length} 条）` : ""}`}
        </button>
        <span className={overLimit ? "text-xs text-amber-600" : "text-xs text-gray-400"}>
          已识别 {parsed.items.length} 条
          {overLimit ? `（超过 ${MAX_LINKS} 条上限）` : ""}
          {parsed.ignored ? ` · ${parsed.ignored} 行无效` : ""}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
        准备阶段（导入/识别/优化{useCards ? "/拆卡" : ""}）并发进行；
        {useCards ? "渲染、上传与发布" : "发布阶段"}
        因本地 rednote 服务单线程而逐条顺序提交，请勿关闭页面。
      </p>

      {error && (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-xs text-gray-600">
          {notice}
        </div>
      )}
      {dedupWarning && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
          ⚠️ {dedupWarning}
        </div>
      )}
      {coverBlockedReason && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-700">
          ⚠️ AI 配图被小红书拦截（{coverBlockedReason}）：{coverBlockedCount} 篇取不到配图，将使用默认封面（多篇可能重复）。建议在 AdsPower 里重新登录小红书、冷却后重试。
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap gap-3 text-xs text-gray-500">
            <span>共 {summary.total} 条</span>
            <span className="text-emerald-600">成功 {summary.done}</span>
            <span className="text-red-500">失败 {summary.failed}</span>
            {summary.skipped > 0 && <span>跳过 {summary.skipped}</span>}
          </div>
          {items.map((item, idx) => {
            const meta = STATUS_META[item.status];
            return (
              <div key={item.id} className="rounded-xl border border-gray-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-gray-400">
                      {idx + 1}. {item.url}
                    </p>
                    {item.title && (
                      <p className="mt-1 truncate text-sm font-medium text-gray-800">{item.title}</p>
                    )}
                    {item.outline && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        {item.outline.cards.length} 张设计卡 · {STYLES[item.outline.style].name} ·{" "}
                        {item.outline.palette === "default"
                          ? "风格自带配色"
                          : PALETTES[item.outline.palette].name}
                      </p>
                    )}
                    {useCards && item.body
                      ? (() => {
                          // 设计卡片模式下完整正文进 caption，超出上限的部分会被截掉。
                          // 标签和 CTA 已由 buildDesc 保住，但仍要让用户看见丢了多少。
                          const d = buildDesc(item.body, item.tags ?? [], { ctaLine: CTA_LINE });
                          return d.truncated ? (
                            <p className="mt-1 text-[11px] text-amber-600">
                              笔记正文超上限，末尾 {d.omitted} 字被截掉（标签与 CTA 已保住）
                            </p>
                          ) : null;
                        })()
                      : null}
                    {item.overflow?.length ? (
                      <p className="mt-1 text-[11px] text-amber-600">
                        第 {item.overflow.join("、")} 张文字偏长，已自动缩到最小字号
                      </p>
                    ) : null}
                    {item.published && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        {item.published.tags.length
                          ? `已带 ${item.published.tags.length} 个话题`
                          : "未带话题"}
                        {item.published.original ? " · 已声明原创" : ""}
                        {item.published.missingTags.length
                          ? ` · 无同名话题被丢弃：${item.published.missingTags.join("、")}`
                          : ""}
                      </p>
                    )}
                    {item.error && <p className="mt-1 text-xs text-red-500">{item.error}</p>}
                    {item.shareLink && (
                      <a
                        href={item.shareLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs text-xhs underline transition hover:text-xhs-dark"
                      >
                        查看已发布的笔记 →
                      </a>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${meta.cls}`}>
                      {meta.label}
                    </span>
                    {item.status === "failed" && (
                      <button
                        type="button"
                        onClick={() => onRetry(item.id)}
                        disabled={running}
                        className="text-[11px] text-gray-500 underline transition hover:text-xhs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        重试
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
