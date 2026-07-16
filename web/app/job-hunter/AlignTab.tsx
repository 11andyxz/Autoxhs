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

const ACCEPT =
  ".docx,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html";

const LOADING_HINTS = [
  "正在读取规则文档……",
  "正在按规则改写简历(保留原格式,约 2~4 分钟)……",
  "正在逐条核对规则、重排版式……",
  "整份简历保留格式改写较慢,请耐心等待……",
];

function isDocx(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(".docx") ||
    file.type.includes("wordprocessingml")
  );
}
function isHtml(file: File): boolean {
  const n = file.name.toLowerCase();
  return n.endsWith(".html") || n.endsWith(".htm") || file.type === "text/html";
}

/** 用 docx-preview 把 .docx 高保真渲染成带内联样式的自包含 HTML(保留字体/字号/颜色/版式)。 */
async function convertDocxToHtml(file: File): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const buf = await file.arrayBuffer();
  const content = document.createElement("div");
  const styleEl = document.createElement("div");
  content.style.cssText = "position:fixed;left:-99999px;top:0;width:816px";
  document.body.appendChild(content);
  document.body.appendChild(styleEl);
  try {
    await renderAsync(buf, content, styleEl, {
      className: "docx",
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
    });
    const css = styleEl.innerHTML; // <style>…</style> 块
    const bodyHtml = content.innerHTML;
    return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${bodyHtml}</body></html>`;
  } finally {
    content.remove();
    styleEl.remove();
  }
}

/** 把上传的 .docx / .html 统一转成 HTML 字符串(简历与模板共用)。 */
async function fileToHtml(file: File): Promise<string> {
  if (isDocx(file)) return convertDocxToHtml(file);
  if (isHtml(file)) {
    const text = await file.text();
    if (!text.trim()) throw new Error("empty");
    return text;
  }
  throw new Error("unsupported");
}

export default function AlignTab() {
  const [fileName, setFileName] = useState("");
  const [sourceHtml, setSourceHtml] = useState<string | null>(null); // 转换/上传得到的「原格式」HTML
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  // 可选模板:传了就用模板的格式,否则保留简历自身格式
  const [templateName, setTemplateName] = useState("");
  const [templateHtml, setTemplateHtml] = useState<string | null>(null);
  const [templateConverting, setTemplateConverting] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  // 规则链接:至少留一个空输入框,可增删
  const [urls, setUrls] = useState<string[]>([""]);
  const [showPaste, setShowPaste] = useState(false);
  const [pastedRules, setPastedRules] = useState("");

  const [loading, setLoading] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [resultHtml, setResultHtml] = useState<string | null>(null);
  const [sources, setSources] = useState<RuleSource[]>([]);

  const sourceFrameRef = useRef<HTMLIFrameElement | null>(null);
  const resultFrameRef = useRef<HTMLIFrameElement | null>(null);
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
    if (resultHtml && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [resultHtml]);

  async function handleFile(file: File | null) {
    setConvertError(null);
    setSourceHtml(null);
    setResultHtml(null);
    setError(null);
    if (!file) {
      setFileName("");
      return;
    }
    setFileName(file.name);
    if (!isDocx(file) && !isHtml(file)) {
      setConvertError("仅支持 .docx 或 .html 文件(不支持旧版 .doc)。");
      return;
    }
    try {
      setConverting(true);
      setSourceHtml(await fileToHtml(file));
    } catch {
      setConvertError("转换失败,请确认文件是有效的 .docx / .html。");
    } finally {
      setConverting(false);
    }
  }

  async function handleTemplateFile(file: File | null) {
    setTemplateError(null);
    setTemplateHtml(null);
    setResultHtml(null);
    if (!file) {
      setTemplateName("");
      return;
    }
    setTemplateName(file.name);
    if (!isDocx(file) && !isHtml(file)) {
      setTemplateError("模板仅支持 .html 或 .docx 文件。");
      return;
    }
    try {
      setTemplateConverting(true);
      setTemplateHtml(await fileToHtml(file));
    } catch {
      setTemplateError("模板转换失败,请确认文件有效。");
    } finally {
      setTemplateConverting(false);
    }
  }

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
    if (!sourceHtml) {
      setError("请先上传简历(.docx 或 .html)并等待转换完成。");
      return;
    }
    if (!cleanUrls.length && !pastedRules.trim()) {
      setError("请至少提供一个规则来源(Google Docs 链接,或粘贴规则文本)。");
      return;
    }
    setError(null);
    setResultHtml(null);
    setSources([]);
    setLoading(true);
    try {
      const res = await fetch("/api/job-hunter/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeHtml: sourceHtml,
          templateHtml: templateHtml || undefined,
          ruleUrls: cleanUrls,
          ruleText: pastedRules.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok || !json?.success || !json.html) {
        setError(json?.error || "改写失败,请稍后重试。");
        if (json?.sources) setSources(json.sources);
        return;
      }
      setResultHtml(json.html);
      setSources(json.sources ?? []);
    } catch {
      setError("网络异常,请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function printFrame(ref: React.RefObject<HTMLIFrameElement | null>) {
    const win = ref.current?.contentWindow;
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
  function handleDownloadWord() {
    if (!resultHtml) return;
    // Word 以 .doc 打开 HTML 时能保留大部分排版
    download(new Blob([resultHtml], { type: "application/msword" }), "Resume_aligned.doc");
  }
  function handleDownloadHtml() {
    if (!resultHtml) return;
    download(new Blob([resultHtml], { type: "text/html" }), "Resume_aligned.html");
  }

  const canAlign = !!sourceHtml && !converting && !templateConverting && !loading;

  return (
    <>
      <header className="mt-2 mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          按规则改写简历,<span className="text-emerald-600">保留原格式</span>
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          上传你的简历(.docx / .html),我会
          <b>先高保真地把它转成 HTML(字体 / 字号 / 颜色 / 版式都保留,见下方预览)</b>,再贴上一个或多个
          「简历规则 / 模板要求」的 Google Docs 链接,AI 会按规则改写内容(增删小节、补足条目数、屏蔽指定公司名等)。
          默认<b>保留你简历原本的排版</b>;若你在 ③ 传一个 <b>模板</b>,则改用<b>模板的排版</b>、填入你的简历内容。最后可直接打印成 PDF 或下载。
        </p>
      </header>

      {/* ① 简历 */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">① 你的简历(.docx 或 .html)</h2>
        <div className="mt-3">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50/40">
            <input
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            {fileName ? (
              <span className="font-medium text-slate-700">📄 {fileName}</span>
            ) : (
              <span>点击选择 Word(.docx)或 HTML(.html)文件</span>
            )}
          </label>
        </div>
        {converting && (
          <p className="mt-2 text-xs text-emerald-600">正在把简历转成 HTML(保留格式)…</p>
        )}
        {convertError && <p className="mt-2 text-sm text-rose-600">{convertError}</p>}

        {/* 转换后的「原格式」预览 —— 让「先生成 HTML」这一步可见 */}
        {sourceHtml && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              转成的 HTML(原格式预览 · 改写前)
            </p>
            <iframe
              ref={sourceFrameRef}
              srcDoc={sourceHtml}
              title="原格式预览"
              sandbox="allow-same-origin"
              className="h-[420px] w-full rounded-xl border border-slate-100 bg-white"
            />
          </div>
        )}
      </div>

      {/* ② 规则 */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">② 规则文档(Google Docs 链接,可多个)</h2>
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
          规则文档需设为「知道链接的任何人可查看」,否则读不到内容。
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
            placeholder="把规则 / 模板要求直接粘贴到这里(可与上面的链接一起用)……"
            rows={6}
            className="mt-3 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
          />
        )}
      </div>

      {/* ③ 模板(可选) */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">
          ③ 模板(.html 或 .docx,可选)
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          传了模板就<b>按模板的排版</b>输出、填入你的简历内容;不传则保留你简历原本的排版。
        </p>
        <div className="mt-3">
          <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50/40">
            <input
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => handleTemplateFile(e.target.files?.[0] ?? null)}
            />
            {templateName ? (
              <span className="font-medium text-slate-700">🎨 {templateName}</span>
            ) : (
              <span>点击选择模板(HTML / Word 文件)</span>
            )}
          </label>
        </div>
        {templateConverting && (
          <p className="mt-2 text-xs text-emerald-600">正在读取模板…</p>
        )}
        {templateError && <p className="mt-2 text-sm text-rose-600">{templateError}</p>}
        {templateHtml && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              模板预览(目标排版)
            </p>
            <iframe
              srcDoc={templateHtml}
              title="模板预览"
              sandbox="allow-same-origin"
              className="h-[320px] w-full rounded-xl border border-slate-100 bg-white"
            />
          </div>
        )}
      </div>

      {/* 免责声明 */}
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm">
        <p className="text-xs leading-relaxed text-amber-700">
          ⚠️ 为满足规则(如「每个项目至少 12 条」「覆盖 X 年经验」等),AI 可能补充、扩写甚至编造经历、
          公司、日期与数字;这些内容未必真实,投递前请务必自行核对并自行承担风险。
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
      )}

      <button
        onClick={handleAlign}
        disabled={!canAlign}
        className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? LOADING_HINTS[hintIndex] : converting ? "正在转换简历…" : "按规则改写简历"}
      </button>
      <p className="mt-2 text-center text-xs text-slate-400">
        为保留原格式,整份改写较慢(约 2~4 分钟),期间请勿关闭页面。
      </p>

      {/* 规则来源反馈(成功/失败都展示,便于排查链接权限问题) */}
      {sources.length > 0 && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">规则来源</p>
          <ul className="mt-2 space-y-1 text-xs">
            {sources.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden>{s.ok ? "✅" : "⚠️"}</span>
                <span className={`min-w-0 flex-1 break-all ${s.ok ? "text-slate-600" : "text-amber-600"}`}>
                  {s.url}
                  {s.ok ? `(读取 ${s.chars} 字)` : `(${s.error || "读取失败"})`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 结果 */}
      {resultHtml && (
        <div ref={resultRef} className="mt-10 space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-slate-800">下载文件</p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                onClick={() => printFrame(resultFrameRef)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
              >
                <span aria-hidden>📄</span>
                下载 PDF(打印)
              </button>
              <button
                onClick={handleDownloadWord}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50/40"
              >
                <span aria-hidden>📝</span>
                下载 Word(.doc)
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
              PDF 由浏览器打印生成:点「下载 PDF」后,在打印窗口的「目标 / 打印机」里选「另存为 PDF」即可(版式与下方预览一致)。
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              改写后的简历({templateHtml ? "套用模板排版" : "保留原格式"} · 下方即为打印 / PDF 效果)
            </p>
            <iframe
              ref={resultFrameRef}
              srcDoc={resultHtml}
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
