"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatBytes,
  MB,
  parseTargetMb,
  searchBestSetting,
  type EncodeFn,
  type SearchResult,
} from "@/lib/imageCompress/search";

type OutFormat = "image/jpeg" | "image/webp";

type Original = {
  name: string;
  size: number;
  width: number;
  height: number;
  type: string;
  url: string; // objectURL
  img: HTMLImageElement;
  hasAlpha: boolean; // PNG/WebP 可能带透明
};

type Compressed = {
  url: string;
  result: SearchResult;
  format: OutFormat;
  filename: string;
};

const ACCEPT = "image/jpeg,image/png,image/webp";

/** 用 canvas 按缩放档+画质重新编码;JPEG 无透明,先铺白底避免透明变黑。 */
function makeCanvasEncoder(img: HTMLImageElement, format: OutFormat): EncodeFn {
  return (scale, quality) =>
    new Promise((resolve, reject) => {
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      if (format === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("toBlob 返回空(该格式可能不被浏览器支持)"));
            return;
          }
          resolve({ size: blob.size, blob, width: w, height: h });
        },
        format,
        quality,
      );
    });
}

function extFor(format: OutFormat): string {
  return format === "image/webp" ? "webp" : "jpg";
}

export default function ImageCompressPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [original, setOriginal] = useState<Original | null>(null);
  const [targetInput, setTargetInput] = useState("1");
  const [format, setFormat] = useState<OutFormat>("image/jpeg");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [compressed, setCompressed] = useState<Compressed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 卸载时释放 objectURL
  const urlsRef = useRef<string[]>([]);
  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const track = (u: string) => {
    urlsRef.current.push(u);
    return u;
  };

  const resetOutputs = () => {
    setCompressed((c) => {
      if (c) URL.revokeObjectURL(c.url);
      return null;
    });
    setError(null);
    setNote(null);
  };

  const loadFile = useCallback(async (file: File) => {
    resetOutputs();
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("仅支持 JPG / PNG / WebP 图片(HEIC 等请先转成这些格式)。");
      return;
    }
    const url = track(URL.createObjectURL(file));
    const img = new Image();
    img.onload = () => {
      // PNG/WebP 视为可能带透明(用于是否提示铺白底)
      const hasAlpha = file.type === "image/png" || file.type === "image/webp";
      setOriginal({
        name: file.name,
        size: file.size,
        width: img.naturalWidth,
        height: img.naturalHeight,
        type: file.type,
        url,
        img,
        hasAlpha,
      });
    };
    img.onerror = () => setError("无法读取这张图片,可能已损坏或格式不支持。");
    img.src = url;
  }, []);

  const handleCompress = async () => {
    if (!original || busy) return;
    const targetMb = parseTargetMb(targetInput);
    if (targetMb == null) {
      setError("请输入一个大于 0 的目标大小(MB),例如 0.5 或 2。");
      return;
    }
    resetOutputs();
    const targetBytes = Math.round(targetMb * MB);

    // 已经小于等于目标:无需压缩。
    if (original.size <= targetBytes) {
      setNote(
        `原图 ${formatBytes(original.size)} 已经小于目标 ${formatBytes(targetBytes)},无需压缩。如仍想更小,可把目标调低后再压。`,
      );
      return;
    }

    setBusy(true);
    setProgress("准备中…");
    try {
      const encode = makeCanvasEncoder(original.img, format);
      const result = await searchBestSetting({
        targetBytes,
        encode,
        onProgress: ({ scale }) => setProgress(`压缩中…(尺寸 ${Math.round(scale * 100)}%)`),
      });
      const url = track(URL.createObjectURL(result.blob));
      const base = original.name.replace(/\.[^.]+$/, "") || "image";
      setCompressed({ url, result, format, filename: `${base}-compressed.${extFor(format)}` });
      if (!result.hitTarget) {
        setNote(
          `已尽力压到 ${formatBytes(result.size)},仍高于目标 ${formatBytes(targetBytes)}。可把目标放宽,或选 WebP 格式通常更小。`,
        );
      } else if (format === "image/jpeg" && original.hasAlpha) {
        setNote("输出为 JPEG,原图的透明区域已填成白色;想保留透明请改选 WebP。");
      }
    } catch (e) {
      console.error("[image-compress] 压缩失败", e);
      setError("压缩失败,请重试或换一张图片。");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const download = () => {
    if (!compressed) return;
    const a = document.createElement("a");
    a.href = compressed.url;
    a.download = compressed.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const ratio =
    original && compressed ? Math.round((1 - compressed.result.size / original.size) * 100) : 0;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回工具箱
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-600">
            图片压缩 · Image Compressor
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            把图片压到你要的大小
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            上传 JPG / PNG / WebP,设一个目标大小(MB),浏览器本地自动压到该大小或更小:先降画质,
            还不够再按比例缩尺寸。文件全程不上传。
          </p>
        </header>

        {/* ① 选择图片 */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">① 选择图片</h2>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="mt-3 w-full rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 transition hover:border-teal-300 hover:text-teal-600"
          >
            {original ? `已选择:${original.name}(点击可更换)` : "点击选择图片"}
          </button>
          {original && (
            <div className="mt-4 flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={original.url}
                alt="原图预览"
                className="h-20 w-20 rounded-lg border border-slate-200 object-cover"
              />
              <div className="text-sm text-slate-600">
                <p>
                  原始大小:<span className="font-semibold text-slate-800">{formatBytes(original.size)}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {original.width} × {original.height} px · {original.type.replace("image/", "").toUpperCase()}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ② 目标与格式 */}
        {original && (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">② 目标大小与输出格式</h2>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="text-sm text-slate-600">
                <span className="mb-1 block text-xs text-slate-400">目标大小(MB)</span>
                <input
                  type="number"
                  min={0.05}
                  step={0.1}
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400"
                />
              </label>
              <div className="text-sm text-slate-600">
                <span className="mb-1 block text-xs text-slate-400">输出格式</span>
                <div className="flex gap-2">
                  {(
                    [
                      ["image/jpeg", "JPEG(最兼容)"],
                      ["image/webp", "WebP(更小、留透明)"],
                    ] as const
                  ).map(([f, label]) => (
                    <button
                      key={f}
                      onClick={() => {
                        setFormat(f);
                        resetOutputs();
                      }}
                      className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                        format === f
                          ? "bg-teal-500 text-white"
                          : "border border-slate-200 bg-white text-slate-600 hover:border-teal-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <button
              onClick={handleCompress}
              disabled={busy}
              className="mt-5 w-full rounded-xl bg-teal-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? progress || "压缩中…" : "开始压缩"}
            </button>
            {error && (
              <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
            )}
            {note && (
              <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">{note}</p>
            )}
          </div>
        )}

        {/* ③ 结果 */}
        {compressed && original && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">③ 压缩结果</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-400">压缩前</p>
                <p className="mt-1 text-lg font-bold text-slate-700">{formatBytes(original.size)}</p>
                <p className="text-xs text-slate-400">
                  {original.width} × {original.height} px
                </p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-400">压缩后</p>
                <p className="mt-1 text-lg font-bold text-emerald-700">
                  {formatBytes(compressed.result.size)}
                  {ratio > 0 && (
                    <span className="ml-2 text-sm font-medium text-emerald-600">↓ {ratio}%</span>
                  )}
                </p>
                <p className="text-xs text-slate-400">
                  {compressed.result.width} × {compressed.result.height} px ·{" "}
                  {extFor(compressed.format).toUpperCase()} · 画质 {Math.round(compressed.result.quality * 100)}
                </p>
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={compressed.url}
              alt="压缩后预览"
              className="mt-4 max-h-96 w-full rounded-lg border border-slate-200 object-contain"
            />
            <button
              onClick={download}
              className="mt-4 w-full rounded-xl bg-teal-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-600"
            >
              下载压缩后的图片
            </button>
          </div>
        )}

        <footer className="mt-16 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}
