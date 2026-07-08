"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearHandoff,
  resumeExportFilename,
  saveHandoff,
  type ResumeExportKind,
} from "@/lib/job-hunter/handoff";
import { buildResumeHtml } from "@/lib/job-hunter/resumeHtml";
import type { JobHunterResult } from "@/lib/job-hunter/schema";

const LOADING_HINTS = [
  "正在解读简历与 JD……",
  "正在按岗位重排经历、强化关键词……",
  "正在撰写求职信与匹配分析……",
];

type ApiResponse = {
  success: boolean;
  data?: JobHunterResult;
  error?: string;
  jdText?: string;
};

type SourceMode = "file" | "text";
type DownloadKind = ResumeExportKind;

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export default function JobHunterPage() {
  const [resumeMode, setResumeMode] = useState<SourceMode>("file");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState("");

  const [jdMode, setJdMode] = useState<SourceMode>("text");
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState("");

  const [allowEmbellish, setAllowEmbellish] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JobHunterResult | null>(null);
  const [downloading, setDownloading] = useState<DownloadKind | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [resolvedJd, setResolvedJd] = useState("");
  const [startingTraining, setStartingTraining] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);

  const [buildingBank, setBuildingBank] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);

  const [hintIndex, setHintIndex] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const resumeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const router = useRouter();

  const resumeHtml = useMemo(
    () => (result ? buildResumeHtml(result.resume) : ""),
    [result],
  );

  function handlePrintResume() {
    const win = resumeFrameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  }

  async function handleStartTraining() {
    if (!result) return;
    setTrainingError(null);
    setStartingTraining(true);
    try {
      const res = await fetch("/api/job-hunter/interview/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume: result.resume,
          jd: resolvedJd,
          weaknesses: result.analysis.missingKeywords,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; sessionId?: number; error?: string }
        | null;
      if (!res.ok || !json?.success || !json.sessionId) {
        setTrainingError(json?.error || "无法开始训练,请稍后重试。");
        return;
      }
      router.push(`/job-hunter/interview?session=${json.sessionId}`);
    } catch {
      setTrainingError("网络异常,请稍后重试。");
    } finally {
      setStartingTraining(false);
    }
  }

  // 只用简历(JD 可选)直接生成「面试题库」——不需要先定制简历。
  // AI 当面试官按简历出题(重点行为面试 BQ),每题按遗忘曲线安排复习。
  async function handleBuildBank() {
    if (resumeMode === "file" ? !resumeFile : !resumeText.trim()) {
      setBankError("请先提供简历(上传 PDF/DOCX 或粘贴文本)。");
      return;
    }
    setBankError(null);
    setBuildingBank(true);
    const fd = new FormData();
    if (resumeMode === "file" && resumeFile) fd.append("resumeFile", resumeFile);
    else fd.append("resumeText", resumeText);
    // JD 可选:有就带上,让技术题更贴目标岗位
    if (jdMode === "file" ? jdFile : jdText.trim()) {
      if (jdMode === "file" && jdFile) fd.append("jdFile", jdFile);
      else fd.append("jdText", jdText);
    }
    try {
      const res = await fetch("/api/job-hunter/interview/build", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; sessionId?: number; error?: string }
        | null;
      if (!res.ok || !json?.success || !json.sessionId) {
        setBankError(json?.error || "生成题库失败,请稍后重试。");
        return;
      }
      router.push(`/job-hunter/interview?session=${json.sessionId}`);
    } catch {
      setBankError("网络异常,请稍后重试。");
    } finally {
      setBuildingBank(false);
    }
  }

  // 带着定制简历 + JD 进入投递步骤（客户端交接，见 lib/job-hunter/handoff）。
  function handleGoApply() {
    if (!result) return;
    saveHandoff({ result, jdText: resolvedJd, savedAt: Date.now() });
    router.push("/indeed");
  }

  // 跳过定制，直接去投递：清掉任何旧的交接，避免投递页残留上一次的定制简历。
  function handleSkipToApply() {
    clearHandoff();
    router.push("/indeed");
  }

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
    if (result && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  function validate(): string | null {
    if (resumeMode === "file" ? !resumeFile : !resumeText.trim()) {
      return "请提供简历(上传 PDF/DOCX 或粘贴文本)。";
    }
    if (jdMode === "file" ? !jdFile : !jdText.trim()) {
      return "请提供目标 JD(上传 PDF/DOCX 或粘贴文本)。";
    }
    return null;
  }

  async function handleGenerate() {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setDownloadError(null);
    setResult(null);
    setLoading(true);

    const fd = new FormData();
    if (resumeMode === "file" && resumeFile) fd.append("resumeFile", resumeFile);
    else fd.append("resumeText", resumeText);
    if (jdMode === "file" && jdFile) fd.append("jdFile", jdFile);
    else fd.append("jdText", jdText);
    fd.append("allowEmbellish", allowEmbellish ? "true" : "false");

    try {
      const res = await fetch("/api/job-hunter/generate", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !json?.success || !json.data) {
        setError(json?.error || "生成失败,请稍后重试。");
        return;
      }
      setResult(json.data);
      setResolvedJd(json.jdText ?? (jdMode === "text" ? jdText : ""));
    } catch {
      setError("网络异常,请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(kind: DownloadKind) {
    if (!result) return;
    setDownloadError(null);
    setDownloading(kind);
    try {
      const res = await fetch("/api/job-hunter/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, result }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiResponse | null;
        setDownloadError(json?.error || "下载失败,请稍后重试。");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resumeExportFilename(kind, result);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("下载失败,请稍后重试。");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回工具箱
        </Link>

        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-600">
            求职神器 · Resume Tailor
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            一键把简历改写成「为这份 JD 定制」
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            上传你的简历，再贴上目标岗位的 JD，AI 会按岗位重排经历、强化关键词，并生成求职信和匹配分析，导出 PDF / Word；生成后可直接带着这份简历去投递 Indeed。
          </p>
          <p className="mt-2 text-xs text-slate-400">
            已经有满意的简历了？
            <button
              type="button"
              onClick={handleSkipToApply}
              className="font-medium text-sky-600 hover:text-sky-700"
            >
              跳过定制，直接去投递 Indeed →
            </button>
          </p>
        </header>

        {/* 简历输入 */}
        <SourceCard
          title="① 你的简历"
          mode={resumeMode}
          onMode={setResumeMode}
          file={resumeFile}
          onFile={setResumeFile}
          text={resumeText}
          onText={setResumeText}
          placeholder="把简历内容粘贴到这里……"
          accept={ACCEPT}
        />

        {/* JD 输入 */}
        <SourceCard
          title="② 目标岗位 JD"
          mode={jdMode}
          onMode={setJdMode}
          file={jdFile}
          onFile={setJdFile}
          text={jdText}
          onText={setJdText}
          placeholder="把目标岗位的职位描述(JD)粘贴到这里……"
          accept={ACCEPT}
        />

        {/* 演绎模式开关 */}
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={allowEmbellish}
              onChange={(e) => setAllowEmbellish(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
            />
            <span>
              <span className="text-sm font-medium text-slate-800">
                允许 AI 演绎 / 补充经历（激进匹配）
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-amber-600">
                ⚠️ 打开后 AI 可能编造经历、数字、雇主等以最大化匹配 JD；这些内容未必真实，使用前请自行核对并承担风险。
                关闭时只会基于你原简历的真实内容做重组和强化。
              </span>
            </span>
          </label>
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
        )}

        <button
          onClick={handleGenerate}
          disabled={loading}
          className="mt-5 w-full rounded-xl bg-cyan-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? LOADING_HINTS[hintIndex] : "生成定制简历"}
        </button>

        {/* 面试题库入口(始终可用:只需①的简历,JD 可选;不必先定制简历) */}
        <div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-indigo-900">🧠 简历面试题库 · 遗忘曲线复习</p>
              <p className="mt-1 text-xs leading-relaxed text-indigo-700">
                不改简历也行——用上面「① 你的简历」（JD 可选），我来当面试官，按你的真实经历出一套面试题（以行为面试 BQ 为主），你作答、AI 打分；每道题按遗忘曲线自动安排下次复习。题库绑定这份简历，进度自动保存。
              </p>
            </div>
            <button
              onClick={handleBuildBank}
              disabled={buildingBank}
              className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {buildingBank ? "正在出题…" : "用这份简历生成题库 →"}
            </button>
          </div>
          {bankError && <p className="mt-2 text-sm text-rose-600">{bankError}</p>}
        </div>

        {/* 结果 */}
        {result && (
          <div ref={resultRef} className="mt-10 space-y-6">
            <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-sky-900">🚀 带这份定制简历去投递 Indeed</p>
                  <p className="mt-1 text-xs leading-relaxed text-sky-700">
                    会把这份定制简历和 JD 带到投递页；投递前记得把它下载并更新到你的 Indeed 账号简历，确保投出的是定制版。
                  </p>
                </div>
                <button
                  onClick={handleGoApply}
                  className="shrink-0 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
                >
                  去投递 Indeed →
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-cyan-900">🎯 针对这份 JD 做专项面试训练</p>
                  <p className="mt-1 text-xs leading-relaxed text-cyan-700">
                    按 JD 技能出题 → 你打字作答 → AI 评分定位弱点 → 自适应补强（进度自动保存到数据库）。
                  </p>
                </div>
                <button
                  onClick={handleStartTraining}
                  disabled={startingTraining}
                  className="shrink-0 rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {startingTraining ? "正在准备…" : "开始训练 →"}
                </button>
              </div>
              {trainingError && <p className="mt-2 text-sm text-rose-600">{trainingError}</p>}
            </div>

            <ScoreBlock result={result} />

            <DownloadBlock
              onPrintResume={handlePrintResume}
              onDownload={handleDownload}
              downloading={downloading}
              error={downloadError}
            />

            <ResumeHtmlPreview html={resumeHtml} frameRef={resumeFrameRef} />
            <CoverLetterPreview text={result.coverLetter} />
          </div>
        )}

        <footer className="mt-16 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}

/* ---------- 子组件 ---------- */

function SourceCard({
  title,
  mode,
  onMode,
  file,
  onFile,
  text,
  onText,
  placeholder,
  accept,
}: {
  title: string;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  text: string;
  onText: (t: string) => void;
  placeholder: string;
  accept: string;
}) {
  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
          {(["file", "text"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onMode(m)}
              className={`rounded-md px-3 py-1 font-medium transition ${
                mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              {m === "file" ? "上传文件" : "粘贴文本"}
            </button>
          ))}
        </div>
      </div>

      {mode === "file" ? (
        <div className="mt-3">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500 transition hover:border-cyan-300 hover:bg-cyan-50/40">
            <input
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="font-medium text-slate-700">📄 {file.name}</span>
            ) : (
              <span>点击选择 PDF / DOCX 文件</span>
            )}
          </label>
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={placeholder}
          rows={8}
          className="mt-3 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
        />
      )}
    </div>
  );
}

function ScoreBlock({ result }: { result: JobHunterResult }) {
  const { analysis } = result;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center justify-center rounded-xl bg-cyan-50 px-5 py-3">
          <span className="text-3xl font-bold text-cyan-600">{analysis.matchScore}</span>
          <span className="text-xs text-cyan-500">/ 100 匹配度</span>
        </div>
        <div className="text-sm text-slate-500">
          <p>生成语言：{result.language}</p>
          <p className="mt-1">已强化 {analysis.addedKeywords.length} 个关键词 · 仍缺 {analysis.missingKeywords.length} 个</p>
        </div>
      </div>

      <KeywordRow label="已强化关键词" items={analysis.addedKeywords} tone="emerald" />
      <KeywordRow label="仍缺失 / 待补充" items={analysis.missingKeywords} tone="amber" />

      {analysis.changeSummary.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">改动摘要</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {analysis.changeSummary.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-cyan-500">•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KeywordRow({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: "emerald" | "amber";
}) {
  if (!items.length) return null;
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-amber-50 text-amber-700";
  return (
    <div className="mt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((k, i) => (
          <span key={i} className={`rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}>
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function DownloadBlock({
  onPrintResume,
  onDownload,
  downloading,
  error,
}: {
  onPrintResume: () => void;
  onDownload: (k: DownloadKind) => void;
  downloading: DownloadKind | null;
  error: string | null;
}) {
  const downloads: Array<{ kind: DownloadKind; label: string; icon: string }> = [
    { kind: "resume-docx", label: "简历 Word", icon: "📝" },
    { kind: "cover-pdf", label: "求职信 PDF", icon: "✉️" },
    { kind: "analysis-pdf", label: "分析报告 PDF", icon: "📊" },
  ];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">下载文件</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button
          onClick={onPrintResume}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-cyan-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-700"
        >
          <span aria-hidden>📄</span>
          下载简历 PDF
        </button>
        {downloads.map((b) => (
          <button
            key={b.kind}
            onClick={() => onDownload(b.kind)}
            disabled={downloading !== null}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-cyan-300 hover:bg-cyan-50/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden>{b.icon}</span>
            {downloading === b.kind ? "生成中…" : b.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        简历 PDF 由浏览器打印生成：点「下载简历 PDF」后，在打印窗口的「目标 / 打印机」里选「另存为 PDF」即可（版式与下方预览一致）。
      </p>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}

function ResumeHtmlPreview({
  html,
  frameRef,
}: {
  html: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        改写后的简历（下方即为打印 / PDF 效果）
      </p>
      <iframe
        ref={frameRef}
        srcDoc={html}
        title="简历预览"
        className="h-[900px] w-full rounded-xl border border-slate-100 bg-white"
      />
    </div>
  );
}

function CoverLetterPreview({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">求职信 Cover Letter</p>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </div>
  );
}
