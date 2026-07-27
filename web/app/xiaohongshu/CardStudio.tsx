"use client";

import { useState } from "react";

import { LAYOUT_META, PALETTES, STYLES } from "@/lib/xiaohongshu/cards/tokens";
import {
  MAX_CARDS,
  MIN_CARDS,
  type Card,
  type CardOutline,
  type LayoutId,
  type PaletteId,
  type StyleId,
} from "@/lib/xiaohongshu/cards/types";

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

const LAYOUT_OPTIONS = Object.entries(LAYOUT_META) as Array<[LayoutId, { name: string }]>;

type Phase = "idle" | "outlining" | "rendering" | "uploading" | "publishing";

type Feedback = { tone: "info" | "success" | "error"; message: string };

type Props = {
  title: string;
  body: string;
  tags: string[];
  /** 0=公开 1=仅自己可见，与页面上的可见性开关共用 */
  visibility: 0 | 1;
  /** 「从链接导入」时的来源链接，发布成功后记入去重库 */
  sourceUrl?: string;
  watermark: string;
  onPublished: (info: { noteId: string | null; shareLink: string | null }) => void;
};

/**
 * 设计卡片工作台：拆卡 → 渲染 → 逐张微调 → 上传 → 预演/发布。
 *
 * 与「文字卡」模式的本质区别：整叠图都是本地 HTML/CSS 渲染的设计卡（不是小红书
 * 服务端渲染的纯文字长文卡），完整正文退回笔记 caption。
 *
 * 一条硬规则：**任何会改变出图的操作（改文案、换风格配色、重渲某张）都必须清掉
 * 已上传的 fileIds**，否则会发出上一版的旧图。
 */
export default function CardStudio({
  title,
  body,
  tags,
  visibility,
  sourceUrl,
  watermark,
  onPublished,
}: Props) {
  const [style, setStyle] = useState<StyleId | "auto">("auto");
  const [palette, setPalette] = useState<PaletteId | "auto">("auto");
  const [cardCount, setCardCount] = useState<number | "auto">("auto");

  const [deckId, setDeckId] = useState<string | null>(null);
  const [outline, setOutline] = useState<CardOutline | null>(null);
  const [overflow, setOverflow] = useState<number[]>([]);
  /** 每张图的版本号，用来打破 <img> 缓存 —— 重渲后必须换 URL 才看得到新图 */
  const [versions, setVersions] = useState<number[]>([]);
  const [fileIds, setFileIds] = useState<string[] | null>(null);
  /** 出图尺寸由渲染层回报，原样上报给小红书（别在发布侧写死） */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const busy = phase !== "idle";
  const ready = Boolean(deckId && outline && outline.cards.length > 0);
  const canStart = title.trim().length > 0 && body.trim().length > 0;

  /** 出图内容变了：已上传的 file_id 全部作废，避免发出旧图 */
  function invalidateUpload() {
    setFileIds(null);
    setUploadProgress(null);
    setAwaitingConfirm(false);
  }

  function bumpVersion(index?: number) {
    setVersions((prev) => {
      const next = [...prev];
      if (index === undefined) return next.map((v) => v + 1);
      next[index] = (next[index] ?? 0) + 1;
      return next;
    });
  }

  async function renderDeck(nextOutline: CardOutline, id: string, only?: number) {
    const res = await fetch("/api/xiaohongshu/cards/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckId: id, outline: nextOutline, only }),
    });
    const json = (await res.json().catch(() => null)) as
      | {
          success: boolean;
          count?: number;
          overflow?: number[];
          width?: number;
          height?: number;
          error?: string;
        }
      | null;
    if (!json?.success) throw new Error(json?.error ?? "卡片渲染失败。");
    if (json.width && json.height) setSize({ width: json.width, height: json.height });
    return json;
  }

  /** 拆卡 + 首次渲染，一个按钮串起来 */
  async function onGenerate() {
    if (!canStart || busy) return;
    setPhase("outlining");
    setFeedback({ tone: "info", message: "正在把正文拆成卡片……" });
    invalidateUpload();
    try {
      const res = await fetch("/api/xiaohongshu/cards/outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, tags, style, palette, cardCount, watermark }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; deckId?: string; outline?: CardOutline; error?: string }
        | null;
      if (!json?.success || !json.deckId || !json.outline) {
        throw new Error(json?.error ?? "拆卡失败。");
      }

      setPhase("rendering");
      setFeedback({ tone: "info", message: `正在渲染 ${json.outline.cards.length} 张卡片……` });
      const rendered = await renderDeck(json.outline, json.deckId);

      setDeckId(json.deckId);
      setOutline(json.outline);
      setOverflow(rendered.overflow ?? []);
      setVersions(json.outline.cards.map(() => 1));
      setFeedback({
        tone: "success",
        message: `已生成 ${json.outline.cards.length} 张卡片。可以逐张微调，满意后再上传发布。`,
      });
    } catch (err) {
      setFeedback({ tone: "error", message: (err as Error).message || "生成失败，请重试。" });
    } finally {
      setPhase("idle");
    }
  }

  /** 改了 outline（换风格/配色/改文案/换布局）后整叠重渲 */
  async function rerenderAll(nextOutline: CardOutline) {
    if (!deckId || busy) return;
    setPhase("rendering");
    setFeedback({ tone: "info", message: "正在重新渲染……" });
    invalidateUpload();
    try {
      const rendered = await renderDeck(nextOutline, deckId);
      setOutline(nextOutline);
      setOverflow(rendered.overflow ?? []);
      bumpVersion();
      setFeedback({ tone: "success", message: "已重新渲染。" });
    } catch (err) {
      setFeedback({ tone: "error", message: (err as Error).message || "渲染失败，请重试。" });
    } finally {
      setPhase("idle");
    }
  }

  /** 只重渲某一张（改了这张的文案/布局后） */
  async function rerenderOne(index: number, nextOutline: CardOutline) {
    if (!deckId || busy) return;
    setPhase("rendering");
    invalidateUpload();
    try {
      const rendered = await renderDeck(nextOutline, deckId, index + 1);
      setOutline(nextOutline);
      const n = index + 1;
      setOverflow((prev) => {
        const rest = prev.filter((x) => x !== n);
        return (rendered.overflow ?? []).includes(n) ? [...rest, n].sort((a, b) => a - b) : rest;
      });
      bumpVersion(index);
      setFeedback({ tone: "success", message: `第 ${n} 张已重新生成。` });
    } catch (err) {
      setFeedback({ tone: "error", message: (err as Error).message || "渲染失败，请重试。" });
    } finally {
      setPhase("idle");
    }
  }

  function updateCard(index: number, patch: Partial<Card>) {
    if (!outline) return null;
    const cards = outline.cards.map((c, i) => (i === index ? { ...c, ...patch } : c));
    return { ...outline, cards };
  }

  /** 串行上传（rednote 服务全局串行，且这样才能给出真实的 x/N 进度） */
  async function ensureUploaded(): Promise<string[]> {
    if (fileIds && outline && fileIds.length === outline.cards.length) return fileIds;
    if (!deckId || !outline) throw new Error("请先生成卡片。");

    const total = outline.cards.length;
    setPhase("uploading");
    setUploadProgress({ done: 0, total });
    const ids: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const res = await fetch("/api/xiaohongshu/cards/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, index: i }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; fileId?: string; error?: string }
        | null;
      if (!json?.success || !json.fileId) {
        throw new Error(json?.error ?? `第 ${i} 张上传失败。`);
      }
      ids.push(json.fileId);
      setUploadProgress({ done: i, total });
    }
    setFileIds(ids);
    return ids;
  }

  async function publish(confirm: boolean) {
    if (!ready || busy) return;
    setAwaitingConfirm(false);
    setFeedback({
      tone: "info",
      message: confirm ? "正在提交到小红书，请勿关闭页面……" : "正在预演，不会真实发布……",
    });
    try {
      const ids = await ensureUploaded();
      setPhase("publishing");
      const res = await fetch("/api/xiaohongshu/publish-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          tags,
          fileIds: ids,
          width: size?.width,
          height: size?.height,
          privacy: visibility,
          confirm,
          sourceUrl: sourceUrl?.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            success: boolean;
            dryRun?: boolean;
            published?: boolean;
            imageCount?: number;
            descPreview?: string;
            noteId?: string | null;
            shareLink?: string | null;
            dedupRecorded?: boolean;
            error?: string;
          }
        | null;
      if (!json?.success) throw new Error(json?.error ?? "发布请求失败。");

      if (json.published) {
        onPublished({ noteId: json.noteId ?? null, shareLink: json.shareLink ?? null });
        const visLabel = visibility === 1 ? "仅自己可见" : "公开";
        const dedupWarn =
          sourceUrl?.trim() && json.dedupRecorded === false ? "（去重库未记录，重发有风险）" : "";
        setFeedback({
          tone: "success",
          message: `发布成功（${visLabel}）：${json.imageCount ?? ids.length} 张设计卡已提交。${dedupWarn}`,
        });
      } else {
        setFeedback({
          tone: "success",
          message:
            `预演完成：将发布 ${json.imageCount ?? ids.length} 张图 · ` +
            `${visibility === 1 ? "仅自己可见" : "公开"} · caption 开头「${json.descPreview?.slice(0, 40) ?? ""}…」。` +
            `图已上传，正式发布不会重复上传。`,
        });
      }
    } catch (err) {
      setFeedback({ tone: "error", message: (err as Error).message || "发布失败，请重试。" });
    } finally {
      setPhase("idle");
      setUploadProgress(null);
    }
  }

  const phaseLabel =
    phase === "outlining"
      ? "正在拆卡…"
      : phase === "rendering"
        ? "正在渲染…"
        : phase === "uploading"
          ? `上传第 ${uploadProgress?.done ?? 0}/${uploadProgress?.total ?? 0} 张…`
          : phase === "publishing"
            ? "提交中…"
            : null;

  return (
    <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <p className="text-[11px] text-gray-500">
        设计卡片模式：正文不会逐字入图，只提炼成 {MIN_CARDS}~{MAX_CARDS} 张卡片；完整正文仍放在笔记正文（caption）里。
      </p>

      {/* 控件 */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          风格
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as StyleId | "auto")}
            disabled={busy}
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
            value={palette}
            onChange={(e) => setPalette(e.target.value as PaletteId | "auto")}
            disabled={busy}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm outline-none focus:border-xhs disabled:opacity-50"
          >
            {PALETTE_OPTIONS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          张数
          <select
            value={String(cardCount)}
            onChange={(e) =>
              setCardCount(e.target.value === "auto" ? "auto" : Number(e.target.value))
            }
            disabled={busy}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm outline-none focus:border-xhs disabled:opacity-50"
          >
            <option value="auto">自动</option>
            {Array.from({ length: MAX_CARDS - MIN_CARDS + 1 }, (_, i) => MIN_CARDS + i).map((n) => (
              <option key={n} value={n}>
                {n} 张
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || !canStart}
          className="inline-flex items-center gap-1.5 rounded-lg bg-xhs px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {phaseLabel ?? (ready ? "重新拆卡并生成" : "拆卡并生成卡片")}
        </button>
        {ready && outline && (
          <button
            type="button"
            onClick={() => rerenderAll({ ...outline, style: outline.style, palette: outline.palette })}
            disabled={busy}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
            title="不重新拆卡，只按当前 outline 再渲染一次"
          >
            重渲全部
          </button>
        )}
      </div>

      {/* 换风格/配色：已有卡片时就地重渲，不重新拆卡（省一次模型调用，内容也不会变） */}
      {ready && outline && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>
            当前：{STYLES[outline.style].name} ·{" "}
            {outline.palette === "default" ? "风格自带配色" : PALETTES[outline.palette].name}
            {size ? ` · ${size.width}×${size.height}` : ""}
          </span>
          <button
            type="button"
            onClick={() => {
              const next = {
                ...outline,
                style: (style === "auto" ? outline.style : style) as StyleId,
                palette: (palette === "auto" ? outline.palette : palette) as PaletteId,
              };
              void rerenderAll(next);
            }}
            disabled={busy}
            className="underline transition hover:text-gray-700 disabled:opacity-50"
          >
            套用上面选的风格/配色（不改文案）
          </button>
        </div>
      )}

      {overflow.length > 0 && (
        <p className="mt-2 text-xs text-amber-600">
          第 {overflow.join("、")} 张文字过长，已自动缩到最小字号仍偏挤，建议精简这几张的文案。
        </p>
      )}

      {/* 卡片预览带 */}
      {ready && outline && deckId && (
        <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
          {outline.cards.map((card, i) => (
            <div key={i} className="w-44 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/xiaohongshu/cards/file/${deckId}/${i + 1}?v=${versions[i] ?? 1}`}
                alt={`第 ${i + 1} 张卡片`}
                className="w-44 rounded-lg border border-gray-200 bg-white"
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-gray-500">
                <span>
                  {i + 1} · {card.kind === "cover" ? "封面" : card.kind === "ending" ? "结尾" : LAYOUT_META[card.layout].name}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingIndex(editingIndex === i ? null : i)}
                  disabled={busy}
                  className="underline transition hover:text-gray-700 disabled:opacity-50"
                >
                  {editingIndex === i ? "收起" : "编辑"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 单卡编辑：改的是 outline（结构化数据），不是 HTML */}
      {ready && outline && editingIndex !== null && outline.cards[editingIndex] && (
        <CardEditor
          card={outline.cards[editingIndex]}
          index={editingIndex}
          disabled={busy}
          onApply={(patch) => {
            const next = updateCard(editingIndex, patch);
            if (next) void rerenderOne(editingIndex, next);
          }}
        />
      )}

      {/* 发布区：与文字卡模式同一套两步闸门 */}
      {ready && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => publish(false)}
            disabled={busy || awaitingConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dry Run（预演）
          </button>
          <button
            type="button"
            onClick={() => {
              setAwaitingConfirm(true);
              setFeedback({
                tone: "info",
                message: `即将以${visibility === 1 ? "「仅自己可见」" : "「公开」"}发布 ${outline?.cards.length ?? 0} 张设计卡笔记，确认？`,
              });
            }}
            disabled={busy || awaitingConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            Post（发布）
          </button>
          {fileIds && (
            <span className="self-center text-xs text-gray-400">
              已上传 {fileIds.length} 张，改动任何一张都会重新上传
            </span>
          )}
        </div>
      )}

      {(feedback || awaitingConfirm) && (
        <div
          className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
            feedback?.tone === "error"
              ? "border-red-200 bg-red-50 text-red-700"
              : feedback?.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
          role="status"
          aria-live="polite"
        >
          <p>{feedback?.message}</p>
          {awaitingConfirm && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => publish(true)}
                className="rounded-lg bg-xhs px-3 py-2 text-sm font-semibold text-white transition hover:bg-xhs-dark"
              >
                确认发布
              </button>
              <button
                type="button"
                onClick={() => {
                  setAwaitingConfirm(false);
                  setFeedback({ tone: "info", message: "已取消发布。" });
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 单张卡的就地编辑器：标题/副标题/要点/版式。改完点「应用并重渲这张」。 */
function CardEditor({
  card,
  index,
  disabled,
  onApply,
}: {
  card: Card;
  index: number;
  disabled: boolean;
  onApply: (patch: Partial<Card>) => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [subtitle, setSubtitle] = useState(card.subtitle ?? "");
  const [badge, setBadge] = useState(card.badge ?? "");
  const [layout, setLayout] = useState<LayoutId>(card.layout);
  const [itemsText, setItemsText] = useState(
    card.items.map((it) => (it.label ? `${it.label}｜${it.text}` : it.text)).join("\n"),
  );

  const usesGroups = card.groups.length > 0;

  return (
    <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
      <p className="text-xs font-medium text-gray-600">编辑第 {index + 1} 张</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-gray-500">
          标题
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-xhs"
          />
        </label>
        <label className="text-xs text-gray-500">
          副标题（可空）
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-xhs"
          />
        </label>
        <label className="text-xs text-gray-500">
          角标（可空，2~4 字）
          <input
            value={badge}
            onChange={(e) => setBadge(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-xhs"
          />
        </label>
        <label className="text-xs text-gray-500">
          版式
          <select
            value={layout}
            onChange={(e) => setLayout(e.target.value as LayoutId)}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-xhs"
          >
            {LAYOUT_OPTIONS.map(([id, m]) => (
              <option key={id} value={id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {usesGroups ? (
        <p className="mt-2 text-[11px] text-gray-400">
          这张是分组版式（对比/四象限），分组内容暂不支持在此编辑；可以换成清单类版式后再编辑要点。
        </p>
      ) : (
        <label className="mt-2 block text-xs text-gray-500">
          要点（一行一条，可用「标签｜内容」加前缀短标签）
          <textarea
            value={itemsText}
            onChange={(e) => setItemsText(e.target.value)}
            rows={5}
            className="mt-1 w-full resize-y rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-xhs"
          />
        </label>
      )}

      <button
        type="button"
        disabled={disabled || !title.trim()}
        onClick={() => {
          const items = usesGroups
            ? card.items
            : itemsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [maybeLabel, ...rest] = line.split("｜");
                  return rest.length > 0
                    ? { label: maybeLabel.trim() || null, text: rest.join("｜").trim() }
                    : { label: null, text: line };
                });
          onApply({
            title: title.trim(),
            subtitle: subtitle.trim() || null,
            badge: badge.trim() || null,
            layout,
            items,
          });
        }}
        className="mt-3 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-50"
      >
        应用并重渲这张
      </button>
    </div>
  );
}
