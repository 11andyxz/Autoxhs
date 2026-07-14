"use client";

import Link from "next/link";
import { useState } from "react";

import AlignTab from "./AlignTab";
import TailorTab from "./TailorTab";

type Tab = "tailor" | "align";

export default function JobHunterPage() {
  const [tab, setTab] = useState<Tab>("tailor");

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回工具箱
        </Link>

        <div className="mt-4">
          <span className="inline-flex items-center rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-600">
            求职神器 · Resume Tailor
          </span>
        </div>

        {/* Tab 切换 */}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => setTab("tailor")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "tailor"
                ? "bg-cyan-600 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:border-cyan-300"
            }`}
          >
            🎯 为 JD 定制
          </button>
          <button
            onClick={() => setTab("align")}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "align"
                ? "bg-emerald-600 text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:border-emerald-300"
            }`}
          >
            🧩 按规则对齐改写
          </button>
        </div>

        {tab === "tailor" ? <TailorTab /> : <AlignTab />}

        <footer className="mt-16 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}
