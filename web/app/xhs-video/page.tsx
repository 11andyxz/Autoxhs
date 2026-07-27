"use client";

import Link from "next/link";
import { useState } from "react";

type Segment = { caption: string; narration: string };
type GenData = {
  id: string;
  title: string;
  segmentCount: number;
  durationSec: number;
  sizeBytes: number;
  segments: Segment[];
  note: { title: string; user: string; imageCount: number };
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function XhsVideoPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<GenData | null>(null);

  async function handleGenerate() {
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch("/api/xhs-video/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "生成失败,请重试。");
      } else {
        setData(json.data as GenData);
      }
    } catch {
      setError("网络错误,请确认本地服务在运行后重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <header className="mb-8">
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
            ← 返回工具箱
          </Link>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            🎬 笔记视频讲解
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            粘贴一条你已发布的小红书笔记链接,AI 自动写讲解脚本、配音,为每个分镜生成配图,并配上
            <span className="font-medium text-slate-600">逐句同步字幕</span>拼成竖屏短视频。
            先生成、可预览、可下载 —— 不会自动发布回小红书。
          </p>
          <p className="mt-1 text-xs text-slate-400">
            需本地 rednote 服务(取笔记)+ 已登录的小红书浏览器 + 本机 Chrome。生成约需 1~2 分钟。
          </p>
        </header>

        {/* 输入区 */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="block text-sm font-medium text-slate-700">笔记链接</label>
          <textarea
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="粘贴完整的小红书笔记分享链接(需带 xsec_token)"
            rows={3}
            className="mt-2 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100"
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !url.trim()}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-rose-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                生成中,请稍候…
              </>
            ) : (
              "生成讲解视频"
            )}
          </button>
          {loading && (
            <p className="mt-2 text-xs text-slate-400">
              正在抓取笔记 → 写脚本 → 逐段配音 → 渲染画面 → 合成视频。整个过程较慢,请勿关闭页面。
            </p>
          )}
        </div>

        {/* 错误 */}
        {error && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* 结果 */}
        {data && (
          <div className="mt-6 space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-slate-900">{data.title}</h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    源笔记:{data.note.title || "(无标题)"} · {data.segmentCount} 个镜头(AI 配图)· 逐句字幕 ·{" "}
                    {data.durationSec}s · {formatSize(data.sizeBytes)}
                  </p>
                </div>
                <a
                  href={`/api/xhs-video/file/${data.id}`}
                  className="shrink-0 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
                >
                  下载 mp4
                </a>
              </div>

              {/* 预览 */}
              <video
                key={data.id}
                controls
                playsInline
                className="mt-4 w-full max-w-xs rounded-xl border border-slate-200 bg-black"
                src={`/api/xhs-video/file/${data.id}?inline=1`}
              />
            </div>

            {/* 脚本 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700">讲解脚本(分镜)</h3>
              <ol className="mt-3 space-y-3">
                {data.segments.map((s, i) => (
                  <li key={i} className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs font-semibold text-rose-500">
                      镜头 {i + 1}
                      {s.caption ? ` · 字幕:${s.caption}` : ""}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-700">{s.narration}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
