"use client";

import Link from "next/link";
import { useState } from "react";
import SignEditor from "./SignEditor";
import Convert from "./Convert";
import PdfEditor from "./PdfEditor";

type Tab = "sign" | "edit" | "convert";

export default function PdfToolsPage() {
  const [tab, setTab] = useState<Tab>("sign");

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回工具箱
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600">
            PDF 工具箱 · PDF Toolbox
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            签名 &amp; 内容编辑 &amp; PDF ⇄ Word 互转
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            给 PDF 加上自己的签名(手绘/打字/上传图片,可拖动、可缩放、可多处放置);
            也能直接<strong className="font-semibold text-slate-700">改 PDF 里的字</strong>
            (点一下原文就能改写或删掉,还能加文字/涂白/高亮/插图片、删页转页调页序);
            或者把 PDF 转成可编辑的 Word、把 Word 打印成 PDF。除 Word 互转外全程在浏览器本地完成,文件不上传。
          </p>
        </header>

        {/* Tab 切换 */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setTab("sign")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "sign"
                ? "bg-indigo-500 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
            }`}
          >
            ✍️ PDF 签名编辑
          </button>
          <button
            onClick={() => setTab("edit")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "edit"
                ? "bg-indigo-500 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
            }`}
          >
            ✏️ 编辑 PDF 内容
          </button>
          <button
            onClick={() => setTab("convert")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "convert"
                ? "bg-indigo-500 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
            }`}
          >
            🔄 PDF ⇄ Word 互转
          </button>
        </div>

        {tab === "sign" && <SignEditor />}
        {tab === "edit" && <PdfEditor />}
        {tab === "convert" && <Convert />}

        <footer className="mt-16 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}
