"use client";

import { useEffect, useRef, useState } from "react";

type RuleSource = {
  url: string;
  ok: boolean;
  chars: number;
  error?: string;
};

type ApiResponse = {
  success: boolean;
  html?: string;
  sources?: RuleSource[];
  error?: string;
};

const DOCX_ACCEPT =
  ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const LOADING_HINTS = [
  "正在把简历转成 HTML（保留原格式）……",
  "正在读取规则文档……",
  "正在按规则改写简历……",
];

export default function AlignTab() {
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  // 规则链接:至少留一个空输入框,可增删
  const [urls, setUrls] = useState<string[]>([""]);
  const [showPaste, setShowPaste] = useState(false);
  const [pastedRules, setPastedRules] = useState("");

  const [loading, setLoading] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [html, setHtml] = useState<string | null>(null);
  const [sources, setSources] = useState<RuleSource[]>([]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!loading) {
      setHintIndex(0);
      return;
    }
    const id = setInterval(() => setHintIndex((i) => (i + 1) % LOADING_HINTS.length), 1800);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (html && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [html]);

  function setUrlAt(i: number, v: string) {
    setUrls((prev) => prev.map((u, idx) => (idx === i ? v : u)));
  }
  function addUrl() {
    setUrls((prev) => [...prev, ""]);
  }
  function removeUrl(i: number) {
    setUrls((prev) => (prev.length <= 1 ? [""] : prev.filter((_, idx) => idx !== i)));
  }

  async function handleAlign() {
    const cleanUrls = urls.map((u) => u.trim()).filter(Boolean);
    if (!resumeFile) {
      setError("请上传你的简历（.docx 文件）。");
      return;
    }
    if (!cleanUrls.length && !pastedRules.trim()) {
      setError("请至少提供一个规则来源（Google Docs 链接，或粘贴规则文本）。");
      return;
    }
    setError(null);
    setHtml(null);
    setSources([]);
    setLoading(true);

    const fd = new FormData();
    fd.append("resumeFile", resumeFile);
    fd.append("ruleUrls", JSON.stringify(cleanUrls));
    if (pastedRules.trim()) fd.append("ruleText", pastedRules);

    try {
      const res = await fetch("/api/job-hunter/align", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !json?.success || !json.html) {
        setError(json?.error || "改写失败，请稍后重试。");
        if (json?.sources) setSources(json.sources);
        return;
      }
      setHtml(json.html);
      setSources(json.sources ?? []);
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function handlePrint() {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  }

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Word 以 .doc 打开 HTML 时能保留大部分排版（application/msword）
  function handleDownloadWord() {
    if (!html) return;
    download(new Blob([html], { type: "application/msword" }), "Resume_aligned.doc");
  }
  function handleDownloadHtml() {
    if (!html) return;
    download(new Blob([html], { type: "text/html" }), "Resume_aligned.html");
  }

  return (
    <>
      <header className="mt-2 mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          按规则改写简历，<span className="text-emerald-600">保留原格式</span>
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          上传你的简历（.docx），再贴上一个或多个「简历规则 / 模板要求」的 Google Docs 链接，AI 会
          <b>先把简历转成 HTML 以保留排版</b>，再逐条按规则改写内容（增删小节、补足条目数、技能表格化、
          屏蔽指定公司名等），最后可直接打印成 PDF 或下载 Word。
        </p>
      </header>

      {/* ① 简历 */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">① 你的简历（.docx）</h2>
        <div className="mt-3">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50/40">
            <input
              type="file"
              accept={DOCX_ACCEPT}
              className="hidden"
              onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
            />
            {resumeFile ? (
              <span className="font-medium text-slate-700">📄 {resumeFile.name}</span>
            ) : (
              <span>点击选择 Word 文档（仅支持 .docx，不支持旧版 .doc）</span>
            )}
          </label>
        </div>
      </div>

      {/* ② 规则 */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">② 规则文档（Google Docs 链接，可多个）</h2>
          <button
            type="button"
            onClick={addUrl}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-emerald-300 hover:text-emerald-600"
          >
            + 添加链接
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {urls.map((u, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="url"
                value={u}
                onChange={(e) => setUrlAt(i, e.target.value)}
                placeholder="https://docs.google.com/document/d/……"
                className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
              />
              <button
                type="button"
                onClick={() => removeUrl(i)}
                aria-label="删除该链接"
                className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-2 text-xs text-slate-400 transition hover:border-rose-300 hover:text-rose-500"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <p className="mt-2 text-xs text-slate-400">
          规则文档需设为「知道链接的任何人可查看」，否则读不到内容。
          <button
            type="button"
            onClick={() => setShowPaste((s) => !s)}
            className="ml-1 font-medium text-emerald-600 hover:text-emerald-700"
          >
            {showPaste ? "收起粘贴规则" : "或直接粘贴规则文本"}
          </button>
        </p>

        {showPaste && (
          <textarea
            value={pastedRules}
            onChange={(e) => setPastedRules(e.target.value)}
            placeholder="把规则 / 模板要求直接粘贴到这里（可与上面的链接一起用）……"
            rows={6}
            className="mt-3 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
          />
        )}
      </div>

      {/* 免责声明 */}
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm">
        <p className="text-xs leading-relaxed text-amber-700">
          ⚠️ 为满足规则（如「每个项目至少 12 条」「覆盖 X 年经验」等），AI 可能补充、扩写甚至编造经历、
          公司、日期与数字；这些内容未必真实，投递前请务必自行核对并自行承担风险。
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
      )}

      <button
        onClick={handleAlign}
        disabled={loading}
        className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? LOADING_HINTS[hintIndex] : "按规则改写简历"}
      </button>

      {/* 规则来源反馈（成功/失败都展示，便于排查链接权限问题） */}
      {sources.length > 0 && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">规则来源</p>
          <ul className="mt-2 space-y-1 text-xs">
            {sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden>{s.ok ? "✅" : "⚠️"}</span>
                <span className={`min-w-0 flex-1 break-all ${s.ok ? "text-slate-600" : "text-amber-600"}`}>
                  {s.url}
                  {s.ok ? `（读取 ${s.chars} 字）` : `（${s.error || "读取失败"}）`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 结果 */}
      {html && (
        <div ref={resultRef} className="mt-10 space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-slate-800">下载文件</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                onClick={handlePrint}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
              >
                <span aria-hidden>📄</span>
                下载 PDF（打印）
              </button>
              <button
                onClick={handleDownloadWord}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <span aria-hidden>📝</span>
                下载 Word（.doc）
              </button>
              <button
                onClick={handleDownloadHtml}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <span aria-hidden>🌐</span>
                下载 HTML
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              PDF 由浏览器打印生成：点「下载 PDF」后，在打印窗口的「目标 / 打印机」里选「另存为 PDF」即可（版式与下方预览一致）。
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              改写后的简历（下方即为打印 / PDF 效果）
            </p>
            {/* srcDoc 里是模型生成的 HTML(已在服务端清洗);再用 sandbox 禁用其内部脚本兜底,
                allow-same-origin + allow-modals 保留父页面调用打印的能力。 */}
            <iframe
              ref={frameRef}
              srcDoc={html}
              title="改写后简历预览"
              sandbox="allow-same-origin allow-modals"
              className="h-[900px] w-full rounded-xl border border-slate-100 bg-white"
            />
          </div>
        </div>
      )}
    </>
  );
}
