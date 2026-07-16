"use client";

import { useRef, useState } from "react";

type PageSize = "letter" | "a4";

/** 从 Content-Disposition 里解析文件名(优先 filename*=UTF-8'')。 */
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 忽略,走 fallback */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] || fallback;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** POST 文件到转换接口:成功返回二进制则下载,失败解析 JSON 错误。 */
async function convertAndDownload(
  url: string,
  file: File,
  extra: Record<string, string>,
  expectType: string,
  fallbackName: string,
): Promise<string | null> {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: fd });
  } catch {
    return "网络请求失败,请确认本地服务在运行。";
  }
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes(expectType)) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    return json?.error || "转换失败,请稍后重试。";
  }
  const blob = await res.blob();
  saveBlob(blob, filenameFromDisposition(res.headers.get("content-disposition"), fallbackName));
  return null;
}

export default function Convert() {
  // PDF → Word
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfDone, setPdfDone] = useState(false);

  // Word → PDF
  const docxInputRef = useRef<HTMLInputElement>(null);
  const [docxFile, setDocxFile] = useState<File | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>("letter");
  const [docxBusy, setDocxBusy] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);
  const [docxDone, setDocxDone] = useState(false);

  const handlePdfToWord = async () => {
    if (!pdfFile || pdfBusy) return;
    setPdfBusy(true);
    setPdfError(null);
    setPdfDone(false);
    const base = pdfFile.name.replace(/\.pdf$/i, "");
    const err = await convertAndDownload(
      "/api/pdf-tools/pdf-to-word",
      pdfFile,
      {},
      "wordprocessingml",
      `${base}.docx`,
    );
    setPdfError(err);
    setPdfDone(!err);
    setPdfBusy(false);
  };

  const handleWordToPdf = async () => {
    if (!docxFile || docxBusy) return;
    setDocxBusy(true);
    setDocxError(null);
    setDocxDone(false);
    const base = docxFile.name.replace(/\.docx$/i, "");
    const err = await convertAndDownload(
      "/api/pdf-tools/word-to-pdf",
      docxFile,
      { pageSize },
      "application/pdf",
      `${base}.pdf`,
    );
    setDocxError(err);
    setDocxDone(!err);
    setDocxBusy(false);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* PDF → Word */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">📄 PDF → Word</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          解析 PDF 的文字与版式(标题/段落/项目符号/居中/粗斜体,并尽量保留图片),生成可编辑的 .docx。
          扫描件(纯图片的 PDF)无法提取文字。
        </p>
        <input
          ref={pdfInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            setPdfFile(e.target.files?.[0] || null);
            setPdfError(null);
            setPdfDone(false);
          }}
        />
        <button
          onClick={() => pdfInputRef.current?.click()}
          className="mt-4 w-full rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
        >
          {pdfFile ? `已选择:${pdfFile.name}` : "点击选择 PDF 文件"}
        </button>
        <button
          onClick={handlePdfToWord}
          disabled={!pdfFile || pdfBusy}
          className="mt-4 w-full rounded-xl bg-indigo-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pdfBusy ? "转换中…(大文件可能要十几秒)" : "转换并下载 Word"}
        </button>
        {pdfError && (
          <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{pdfError}</p>
        )}
        {pdfDone && (
          <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            ✅ 转换完成,已开始下载。
          </p>
        )}
      </div>

      {/* Word → PDF */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">📝 Word → PDF</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          高保真保留原文档的字体、字号、对齐与页边距(用本机 Chrome 无头打印),排版接近 Word/WPS 打印效果。旧版 .doc 请先另存为 .docx。
        </p>
        <input
          ref={docxInputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            setDocxFile(e.target.files?.[0] || null);
            setDocxError(null);
            setDocxDone(false);
          }}
        />
        <button
          onClick={() => docxInputRef.current?.click()}
          className="mt-4 w-full rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
        >
          {docxFile ? `已选择:${docxFile.name}` : "点击选择 Word (.docx) 文件"}
        </button>
        <div className="mt-3 flex items-center gap-4 text-sm text-slate-600">
          <span className="text-xs text-slate-400">纸张:</span>
          {(["letter", "a4"] as const).map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="pageSize"
                checked={pageSize === s}
                onChange={() => setPageSize(s)}
                className="accent-indigo-500"
              />
              {s === "letter" ? "Letter(美国信纸)" : "A4"}
            </label>
          ))}
        </div>
        <button
          onClick={handleWordToPdf}
          disabled={!docxFile || docxBusy}
          className="mt-4 w-full rounded-xl bg-indigo-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {docxBusy ? "转换中…(首次会拉起 Chrome,稍等)" : "转换并下载 PDF"}
        </button>
        {docxError && (
          <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{docxError}</p>
        )}
        {docxDone && (
          <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            ✅ 转换完成,已开始下载。
          </p>
        )}
      </div>
    </div>
  );
}
