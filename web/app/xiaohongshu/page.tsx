"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import type { RewriteData } from "@/lib/schema";

const MAX_CHARS = 10_000;
const LOADING_HINTS = [
  "正在分析原文重点……",
  "正在重新组织内容……",
  "正在生成标题和标签……",
];

type ApiResponse = {
  success: boolean;
  data?: RewriteData;
  error?: string;
};

type PublishFeedback = {
  tone: "info" | "success" | "error";
  message: string;
};

export default function XiaohongshuPage() {
  const [input, setInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [noteImages, setNoteImages] = useState<string[]>([]);
  const [ocring, setOcring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<RewriteData | null>(null);
  const [selectedTitleIndex, setSelectedTitleIndex] = useState(0);
  const [editedBody, setEditedBody] = useState("");
  const [isEditingBody, setIsEditingBody] = useState(false);
  const [publishingAction, setPublishingAction] = useState<"dry-run" | "post" | null>(null);
  const [publishFeedback, setPublishFeedback] = useState<PublishFeedback | null>(null);
  const [awaitingPostConfirmation, setAwaitingPostConfirmation] = useState(false);
  // 可见性：0=公开，1=仅自己可见。发布前为意向，发布后即时作用于该笔记（可逆）。
  const [visibility, setVisibility] = useState<0 | 1>(0);
  const [publishedNoteId, setPublishedNoteId] = useState<string | null>(null);
  const [publishedShareLink, setPublishedShareLink] = useState<string | null>(null);
  const [settingPrivacy, setSettingPrivacy] = useState(false);
  // 每张图约多少字：越大单张图字越多、图越少。实测一张图约 380~450 字填满。
  const [charsPerCard, setCharsPerCard] = useState(380);

  const [hintIndex, setHintIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 加载提示轮播
  useEffect(() => {
    if (!loading) {
      setHintIndex(0);
      return;
    }
    const id = setInterval(() => {
      setHintIndex((i) => (i + 1) % LOADING_HINTS.length);
    }, 1800);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  // 从链接导入:调用本地 rednote 服务读取笔记正文,填入参考文案
  async function onImportFromLink() {
    const url = urlInput.trim();
    if (!url) {
      setError("请先粘贴小红书笔记链接。");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/xiaohongshu/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            success: boolean;
            data?: { title?: string; desc?: string; images?: string[]; imageCount?: number };
            error?: string;
          }
        | null;
      if (!json || !json.success || !json.data) {
        setError(json?.error ?? "导入失败,请确认本地 rednote 服务在运行。");
        return;
      }
      const text = [json.data.title, json.data.desc]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_CHARS);
      setInput(text);
      const imgs = json.data.images ?? [];
      setNoteImages(imgs);
      showToast(imgs.length ? `已导入(含 ${imgs.length} 张图,可识别图片文字)` : "已从链接导入");
    } catch {
      setError("导入失败,请确认本地 rednote 服务在运行。");
    } finally {
      setImporting(false);
    }
  }

  // OCR:把导入笔记的图片文字识别出来,追加到参考文案
  async function onOcrImages() {
    if (!noteImages.length) return;
    setOcring(true);
    setError(null);
    try {
      const res = await fetch("/api/xiaohongshu/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls: noteImages }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; text?: string; error?: string }
        | null;
      if (!json || !json.success || !json.text) {
        setError(json?.error ?? "图片文字识别失败,请重试。");
        return;
      }
      setInput((prev) => {
        const merged = prev.trim()
          ? `${prev.trim()}\n\n【图片文字】\n${json.text}`
          : (json.text as string);
        return merged.slice(0, MAX_CHARS);
      });
      showToast("已识别图片文字并加入");
    } catch {
      setError("图片文字识别失败,请重试。");
    } finally {
      setOcring(false);
    }
  }

  const trimmedInput = input.trim();
  const canSubmit = trimmedInput.length > 0 && !loading;

  const selectedTitle = result?.titles[selectedTitleIndex]?.text ?? "";
  const tagsLine = result ? result.tags.join(" ") : "";
  const finalText = result
    ? `${selectedTitle}\n\n${editedBody}\n\n${tagsLine}`
    : "";

  async function handleGenerate() {
    const content = input.trim();
    if (!content) {
      setError("请输入需要优化的文案。");
      return;
    }
    if (content.length > MAX_CHARS) {
      setError("输入内容过长,请适当缩短后重试。");
      return;
    }
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/xiaohongshu/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;

      if (!json || !json.success || !json.data) {
        setError(json?.error ?? "文案生成失败,请稍后重试。");
        return;
      }

      // 成功:重置上一次的选中/编辑状态,避免残留
      setResult(json.data);
      setSelectedTitleIndex(0);
      setEditedBody(json.data.body);
      setIsEditingBody(false);
      // 新内容 = 新的一篇,清掉上一篇已发布笔记的可见性上下文
      setPublishedNoteId(null);
      setPublishedShareLink(null);
    } catch {
      setError("网络连接失败,请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy(text: string, successMessage: string) {
    if (!text) return;
    const ok = await copyToClipboard(text);
    showToast(ok ? successMessage : "复制失败,请手动选择文案进行复制。");
  }

  // 调用本地服务设置某篇已发布笔记的可见性
  async function applyPrivacy(noteId: string, privacy: 0 | 1) {
    setSettingPrivacy(true);
    try {
      const res = await fetch("/api/xiaohongshu/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId, privacy }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; label?: string; error?: string }
        | null;
      return { ok: !!json?.success, label: json?.label, error: json?.error };
    } catch {
      return { ok: false, error: "网络连接失败。" };
    } finally {
      setSettingPrivacy(false);
    }
  }

  // 点击可见性：未发布时仅记录意向；已发布时即时改变该笔记的可见性
  async function onSelectVisibility(next: 0 | 1) {
    setVisibility(next);
    if (!publishedNoteId || settingPrivacy) return;
    const r = await applyPrivacy(publishedNoteId, next);
    setPublishFeedback(
      r.ok
        ? { tone: "success", message: `已将这篇笔记设为「${next === 1 ? "仅自己可见" : "公开"}」。` }
        : { tone: "error", message: r.error ?? "设置可见性失败。" },
    );
  }

  async function handlePublish(confirm: boolean) {
    if (!selectedTitle.trim() || !editedBody.trim()) {
      const message = "请先生成并保留标题和正文。";
      setError(message);
      setPublishFeedback({ tone: "error", message });
      return;
    }

    setPublishingAction(confirm ? "post" : "dry-run");
    setAwaitingPostConfirmation(false);
    setPublishFeedback({
      tone: "info",
      message: confirm
        ? "正在按正文生成长文图片并提交到小红书，请勿关闭页面……"
        : "正在生成长文图片；Dry Run 不会公开发布，请稍候……",
    });
    setError(null);
    try {
      const res = await fetch("/api/xiaohongshu/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: selectedTitle,
          body: editedBody,
          tags: result?.tags ?? [],
          confirm,
          charsPerCard,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            success: boolean;
            dryRun?: boolean;
            published?: boolean;
            cards?: number;
            imageCount?: number;
            noteId?: string | null;
            shareLink?: string | null;
            error?: string;
          }
        | null;
      if (!json?.success) {
        const message = json?.error ?? "发布请求失败，请稍后重试。";
        setError(message);
        setPublishFeedback({ tone: "error", message });
        return;
      }
      const count = json.imageCount ?? json.cards ?? 0;
      if (json.published) {
        setPublishedNoteId(json.noteId ?? null);
        setPublishedShareLink(json.shareLink ?? null);
        let message = `发布成功：已生成 ${count} 张长文图片并提交到当前登录的小红书账号。`;
        // /auto 发布的默认可见性是「仅自己可见」，所以这里必须显式按所选可见性设定（0=公开/1=仅自己可见）
        if (json.noteId) {
          const r = await applyPrivacy(json.noteId, visibility);
          message += r.ok
            ? visibility === 1
              ? " 已设为仅自己可见。"
              : " 已设为公开。"
            : ` 但可见性设置失败（${r.error ?? "请用下方开关重试"}），当前可能仍为发布默认（仅自己可见）。`;
        }
        setPublishFeedback({ tone: "success", message });
      } else {
        setPublishFeedback({
          tone: "success",
          message: `Dry Run 完成：已生成 ${count} 张长文图片，未实际发布。`,
        });
      }
    } catch {
      const message = "网络连接失败，请稍后重试。";
      setError(message);
      setPublishFeedback({ tone: "error", message });
    } finally {
      setPublishingAction(null);
    }
  }

  function requestPostConfirmation() {
    if (!selectedTitle.trim() || !editedBody.trim()) {
      const message = "请先生成并保留标题和正文。";
      setError(message);
      setPublishFeedback({ tone: "error", message });
      return;
    }
    setError(null);
    setAwaitingPostConfirmation(true);
    setPublishFeedback({
      tone: "info",
      message: "即将按正文自动生成长文图片，并真实发布到当前登录的小红书账号。请确认后继续。",
    });
  }

  function handleClear() {
    if (!input && !result) return;
    if (window.confirm("确定要清空所有内容吗?清空后无法恢复。")) {
      setInput("");
      setUrlInput("");
      setNoteImages([]);
      setResult(null);
      setError(null);
      setSelectedTitleIndex(0);
      setEditedBody("");
      setIsEditingBody(false);
      setPublishFeedback(null);
      setAwaitingPostConfirmation(false);
      setVisibility(0);
      setPublishedNoteId(null);
      setPublishedShareLink(null);
    }
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-4 py-10">
        {/* 1. 标题区域 */}
        <header className="mb-8">
          <Link href="/" className="block text-xs text-gray-400 transition hover:text-gray-600">
            ← 工具箱
          </Link>
          <span className="mt-2 inline-flex items-center rounded-full bg-xhs/10 px-3 py-1 text-xs font-medium text-xhs">
            小红书 · 文案助手
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
            小红书文案发表
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            粘贴参考内容,AI 将为你重新组织语言、优化排版,并生成适合小红书发布的标题、正文和标签。
          </p>
        </header>

        {/* 2. 输入区域 */}
        <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          {/* 从链接导入(经本地 rednote 服务读取) */}
          <div className="mb-4 rounded-xl bg-rose-50/60 p-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="粘贴小红书笔记链接(https://www.xiaohongshu.com/explore/...?xsec_token=...)"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40"
              />
              <button
                type="button"
                onClick={onImportFromLink}
                disabled={importing || !urlInput.trim()}
                className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importing ? "导入中…" : "从链接导入"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              通过你本地的 rednote 服务读取笔记正文并填入下方;需该服务运行且浏览器已登录。
            </p>
            {noteImages.length > 0 && (
              <button
                type="button"
                onClick={onOcrImages}
                disabled={ocring}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-xhs/40 bg-white px-3 py-1.5 text-xs font-medium text-xhs transition hover:bg-xhs/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ocring ? "识别中……" : `📷 识别 ${noteImages.length} 张图片中的文字`}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="reference" className="text-sm font-semibold text-gray-800">
              参考文案
            </label>
            <span
              className={
                input.length > MAX_CHARS * 0.9 ? "text-xs text-amber-500" : "text-xs text-gray-400"
              }
            >
              {input.length} / {MAX_CHARS}
            </span>
          </div>

          <textarea
            id="reference"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={MAX_CHARS}
            placeholder="请粘贴需要优化的小红书文案……"
            className="mt-3 min-h-[240px] w-full resize-y rounded-xl border border-gray-200 p-4 text-sm leading-relaxed outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40"
          />

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canSubmit}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-6 py-3 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {loading ? "正在优化文案……" : "开始优化文案"}
            </button>
            {loading && (
              <span className="text-sm text-gray-500">{LOADING_HINTS[hintIndex]}</span>
            )}
          </div>
        </section>

        {/* 错误提示 */}
        {error && (
          <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* 6 & 7. 结果区域 */}
        {result && (
          <div className="mt-6 space-y-6">
            {/* 标题备选 */}
            <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900">选择一个标题</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {result.titles.map((title, i) => {
                  const selected = i === selectedTitleIndex;
                  return (
                    <div
                      key={`${title.text}-${i}`}
                      className={`relative rounded-xl border p-4 transition ${
                        selected
                          ? "border-xhs bg-rose-50 ring-1 ring-xhs"
                          : "border-gray-200 bg-white hover:border-rose-200"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedTitleIndex(i)}
                        className="block w-full pr-10 text-left"
                        aria-pressed={selected}
                      >
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                          {title.style}
                        </span>
                        <p className="mt-2 text-sm font-medium leading-relaxed text-gray-900">
                          {title.text}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopy(title.text, "已复制标题")}
                        className="absolute right-3 top-3 text-xs text-gray-400 transition hover:text-xhs"
                      >
                        复制
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 优化后的正文 */}
            <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">优化后的正文</h2>
                <div className="flex gap-4 text-xs">
                  <button
                    type="button"
                    onClick={() => setIsEditingBody((v) => !v)}
                    className="text-gray-500 transition hover:text-xhs"
                  >
                    {isEditingBody ? "完成编辑" : "编辑正文"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopy(editedBody, "已复制正文")}
                    className="text-gray-500 transition hover:text-xhs"
                  >
                    复制正文
                  </button>
                </div>
              </div>

              {isEditingBody ? (
                <textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="mt-3 min-h-[260px] w-full resize-y rounded-xl border border-gray-200 p-4 text-sm leading-7 outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40"
                />
              ) : (
                <div className="mt-3 whitespace-pre-wrap rounded-xl bg-gray-50 p-4 text-sm leading-7 text-gray-800">
                  {editedBody}
                </div>
              )}
            </section>

            {/* 相关标签 */}
            <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">相关标签</h2>
                <button
                  type="button"
                  onClick={() => handleCopy(tagsLine, "已复制标签")}
                  className="text-xs text-gray-500 transition hover:text-xhs"
                >
                  复制全部标签
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.tags.map((tag, i) => (
                  <span
                    key={`${tag}-${i}`}
                    className="rounded-full bg-rose-50 px-3 py-1 text-xs text-xhs"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>

            {/* 最终发布文案 */}
            <section className="rounded-2xl border-2 border-xhs/20 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900">最终发布文案</h2>
              <p className="mt-1 text-xs text-gray-400">
                根据所选标题、正文和标签自动组合,切换标题或编辑正文都会实时更新。
              </p>
              <textarea
                readOnly
                value={finalText}
                className="mt-3 min-h-[280px] w-full resize-y whitespace-pre-wrap rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm leading-7 text-gray-800 outline-none"
              />

              {/* 可见性：发布前选意向,发布后即时切换（可逆） */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-gray-700">可见性</span>
                <div className="inline-flex overflow-hidden rounded-lg border border-gray-200">
                  {([0, 1] as const).map((v) => {
                    const active = visibility === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => onSelectVisibility(v)}
                        disabled={settingPrivacy || publishingAction !== null}
                        aria-pressed={active}
                        className={`px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          active ? "bg-xhs text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        {v === 0 ? "公开" : "仅自己可见"}
                      </button>
                    );
                  })}
                </div>
                {settingPrivacy ? (
                  <span className="text-xs text-gray-400">正在设置可见性…</span>
                ) : (
                  <span className="text-xs text-gray-400">
                    {publishedNoteId
                      ? "已发布,切换即可实时改变这篇笔记的可见性。"
                      : "发布后将按此设置笔记可见性。"}
                  </span>
                )}
              </div>

              {/* 每张图字数：控制图片数量/密度（越大单张字越多、图越少，更贴近人工长文） */}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-gray-700">每张图字数</span>
                <input
                  type="range"
                  min={120}
                  max={500}
                  step={20}
                  value={charsPerCard}
                  onChange={(e) => setCharsPerCard(Number(e.target.value))}
                  disabled={publishingAction !== null}
                  className="h-1.5 w-40 cursor-pointer accent-xhs disabled:cursor-not-allowed"
                />
                <span className="text-xs text-gray-500">
                  约 {charsPerCard} 字/张 · 预计 {Math.max(1, Math.ceil(editedBody.length / charsPerCard)) + 1} 张图
                </span>
                <span className="text-[11px] text-gray-400">越大单张字越多、图越少（约 380~450 填满一张）</span>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => handleCopy(finalText, "文案已复制")}
                  className="inline-flex items-center justify-center rounded-xl bg-xhs px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-xhs-dark"
                >
                  复制完整文案
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(selectedTitle, "已复制标题")}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:border-gray-300"
                >
                  复制标题
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(editedBody, "已复制正文")}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:border-gray-300"
                >
                  复制正文
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(tagsLine, "已复制标签")}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:border-gray-300"
                >
                  复制标签
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={loading || !trimmedInput}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:border-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  重新生成
                </button>
                <button
                  type="button"
                  onClick={handleClear}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-500 transition hover:border-red-200 hover:text-red-500"
                >
                  清空内容
                </button>
                <button
                  type="button"
                  onClick={() => handlePublish(false)}
                  disabled={
                    publishingAction !== null ||
                    awaitingPostConfirmation ||
                    !selectedTitle.trim() ||
                    !editedBody.trim()
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {publishingAction === "dry-run" && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-amber-800/30 border-t-amber-800" />
                  )}
                  {publishingAction === "dry-run" ? "Dry Run 中…" : "Dry Run"}
                </button>
                <button
                  type="button"
                  onClick={requestPostConfirmation}
                  disabled={
                    publishingAction !== null ||
                    awaitingPostConfirmation ||
                    !selectedTitle.trim() ||
                    !editedBody.trim()
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {publishingAction === "post" && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  )}
                  {publishingAction === "post" ? "发布中…" : "Post"}
                </button>
              </div>

              {publishedShareLink && (
                <a
                  href={publishedShareLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm text-xhs underline transition hover:text-xhs-dark"
                >
                  查看已发布的笔记 →
                </a>
              )}

              {(awaitingPostConfirmation || publishFeedback) && (
                <div
                  className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
                    publishFeedback?.tone === "error"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : publishFeedback?.tone === "success"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  <p>{publishFeedback?.message}</p>
                  {awaitingPostConfirmation && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handlePublish(true)}
                        className="rounded-lg bg-xhs px-3 py-2 text-sm font-semibold text-white transition hover:bg-xhs-dark"
                      >
                        确认发布
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAwaitingPostConfirmation(false);
                          setPublishFeedback({ tone: "info", message: "已取消发布。" });
                        }}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}
