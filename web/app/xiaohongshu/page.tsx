"use client";

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

export default function XiaohongshuPage() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<RewriteData | null>(null);
  const [selectedTitleIndex, setSelectedTitleIndex] = useState(0);
  const [editedBody, setEditedBody] = useState("");
  const [isEditingBody, setIsEditingBody] = useState(false);

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

  function handleClear() {
    if (!input && !result) return;
    if (window.confirm("确定要清空所有内容吗?清空后无法恢复。")) {
      setInput("");
      setResult(null);
      setError(null);
      setSelectedTitleIndex(0);
      setEditedBody("");
      setIsEditingBody(false);
    }
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-4 py-10">
        {/* 1. 标题区域 */}
        <header className="mb-8">
          <span className="inline-flex items-center rounded-full bg-xhs/10 px-3 py-1 text-xs font-medium text-xhs">
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
              </div>
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
