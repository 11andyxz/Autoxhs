"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearHandoff,
  resumeExportFilename,
  saveHandoff,
  type ResumeExportKind,
} from "@/lib/job-hunter/handoff";
import { fileToHtml, isDocx } from "@/lib/job-hunter/docxToHtml";
import { buildResumeHtml } from "@/lib/job-hunter/resumeHtml";
import type { JobHunterResult } from "@/lib/job-hunter/schema";
import { DEFAULT_TAILOR_MODE, type TailorMode } from "@/lib/job-hunter/tailorMode";

const LOADING_HINTS = [
  "正在解读简历与 JD……",
  "正在按岗位重排经历、强化关键词……",
  "正在撰写求职信与匹配分析……",
];

// 保留原格式模式:先转 HTML,再在原版式上按 JD 就地改写(整份改写较慢)。
const PRESERVE_HINTS = [
  "正在把简历转成 HTML(保留原格式)……",
  "正在按 JD 在原版式上就地改写、强化关键词……",
  "保留格式的整份改写较慢(约 3~4 分钟),请耐心等待……",
];

type ApiResponse = {
  success: boolean;
  data?: JobHunterResult;
  error?: string;
  jdText?: string;
  // 保留原格式模式下,后端一并返回「定制后仍保留原格式」的完整简历 HTML。
  resumeHtml?: string;
};

type SourceMode = "file" | "text";
type DownloadKind = ResumeExportKind;

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// 四档尺度由弱到强,互斥。文案要让人一眼看清「哪些事实会被动」。
const TAILOR_MODE_OPTIONS: Array<{
  value: TailorMode;
  label: string;
  desc: string;
  warn?: boolean;
}> = [
  {
    value: "strict",
    label: "只重排措辞（最保守）",
    desc: "只调整顺序和说法，几乎不动你的原句，不改任何事实。",
  },
  {
    value: "adapt",
    label: "按 JD 改写工作内容（不激进）",
    desc:
      "雇主、工作地点、起止时间、职位名称一律不动；在这些真实岗位内，AI 会在你原有内容的基础上按 JD 改写工作内容——" +
      "换成 JD 的技术栈和说法、重排要点、突出相关成果，但不会凭空加你没做过的事，也不会把成果挪到别家公司。",
  },
  {
    value: "light",
    label: "轻度激进：可补充你没做过的工作内容",
    desc:
      "雇主、工作地点、起止时间依然一律不动；但在这些真实岗位内，AI 会为了匹配 JD 补上你其实没做过的职责、" +
      "技术和成果（会贴合那家公司的业务和你当时的职级，尽量可信）。⚠️ 这部分内容不真实，面试时要能自圆其说。",
    warn: true,
  },
  {
    value: "embellish",
    label: "激进匹配：连雇主 / 职位 / 经历都可能编造",
    desc:
      "⚠️ AI 可能编造经历、数字、雇主、职位等以最大化匹配 JD；这些内容未必真实，使用前请自行核对并承担风险。",
    warn: true,
  },
];

export default function TailorTab() {
  const [resumeMode, setResumeMode] = useState<SourceMode>("file");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState("");
  // 是否用的是自动预填的默认简历(用于在卡片下提示一句)。
  const [defaultResumeLoaded, setDefaultResumeLoaded] = useState(false);

  const [jdMode, setJdMode] = useState<SourceMode>("text");
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState("");

  // 改写尺度(四档互斥,见 TAILOR_MODE_OPTIONS);默认「不激进」。
  const [tailorMode, setTailorMode] = useState<TailorMode>(DEFAULT_TAILOR_MODE);
  // 轻度激进的子选项:是否允许把职位名往 JD 方向调(默认不动)。
  const [allowRetitle, setAllowRetitle] = useState(false);
  // 默认保留原格式:上传 .docx 时不套固定模板,在原版式上按 JD 改写。
  // (线上也开着:项目已启用 Vercel Fluid,函数上限 300s;整份改写实测约 139s,放得下。)
  const [preserveFormat, setPreserveFormat] = useState(true);

  const [loading, setLoading] = useState(false);
  const [preserving, setPreserving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JobHunterResult | null>(null);
  // 保留原格式模式下,后端返回的「定制后仍保留原格式」的完整 HTML(替代固定模板渲染)。
  const [preserveHtml, setPreserveHtml] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<DownloadKind | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [resolvedJd, setResolvedJd] = useState("");
  const [startingTraining, setStartingTraining] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);

  const [buildingBank, setBuildingBank] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  const [rebuildBank, setRebuildBank] = useState(false);

  const [hintIndex, setHintIndex] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const resumeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const router = useRouter();
  // 公网部署:Indeed 投递依赖本机服务,远程用不了,隐藏相关入口。
  const isPublicDeploy = process.env.NEXT_PUBLIC_DEPLOY_MODE === "public";

  // 保留原格式时用后端返回的 HTML;否则用固定模板渲染结构化结果。
  const resumeHtml = useMemo(
    () => preserveHtml ?? (result ? buildResumeHtml(result.resume) : ""),
    [preserveHtml, result],
  );

  // 保留原格式只对上传的 .docx 有效;PDF / 粘贴文本无法还原格式,会回退到经典模板。
  const preserveBlocked =
    preserveFormat &&
    resumeMode === "file" &&
    !!resumeFile &&
    !isDocx(resumeFile);

  // 下载 / 打印共用的文件名前缀。
  const resumeFileBase = `${(result?.resume.name?.trim() || "Resume").replace(/[^\w.-]+/g, "_")}_tailored`;

  function handlePrintResume() {
    const win = resumeFrameRef.current?.contentWindow;
    if (!win) return;
    // Chrome 拿**顶层页面标题**给「另存为 PDF」命名,不临时改的话简历会被存成「小红书文案发表.pdf」。
    const prev = document.title;
    document.title = resumeFileBase;
    const restore = () => {
      document.title = prev;
    };
    win.addEventListener("afterprint", restore, { once: true });
    window.addEventListener("afterprint", restore, { once: true });
    window.setTimeout(restore, 60_000); // 兜底:afterprint 没触发也别把标题留住
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
    // 重新生成:覆盖同一简历的旧题库(否则命中旧库直接复用)
    if (rebuildBank) fd.append("rebuild", "true");
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

  // 进页面自动填入默认简历(见 /api/job-hunter/default-resume),不用每次手动选文件;
  // 用户换成别的文件后就不再回填(下面的 setResumeFile 只在还是空的时候执行)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/job-hunter/default-resume");
        if (!res.ok) return;
        const blob = await res.blob();
        const name =
          res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ||
          "resume.docx";
        if (cancelled) return;
        setResumeFile((cur) => cur ?? new File([blob], name, { type: blob.type }));
        setDefaultResumeLoaded(true);
      } catch {
        // 没有默认简历就正常显示空的上传框
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    setPreserveHtml(null);

    // 保留原格式仅对上传的 .docx 有效;其它输入回退到经典模板。
    const canPreserve =
      preserveFormat && resumeMode === "file" && !!resumeFile && isDocx(resumeFile);

    setLoading(true);
    setPreserving(canPreserve);
    try {
      if (canPreserve) {
        // 客户端先把 .docx 高保真转成 HTML(保留字体/版式),再交给后端在原版式上按 JD 改写。
        let sourceHtml: string;
        try {
          sourceHtml = await fileToHtml(resumeFile!);
        } catch {
          setError("简历转换失败,请确认是有效的 .docx 文件。");
          return;
        }
        const fd = new FormData();
        fd.append("resumeHtml", sourceHtml);
        if (jdMode === "file" && jdFile) fd.append("jdFile", jdFile);
        else fd.append("jdText", jdText);
        fd.append("tailorMode", tailorMode);
        if (tailorMode === "light") fd.append("allowRetitle", allowRetitle ? "true" : "false");

        const res = await fetch("/api/job-hunter/generate-preserve", {
          method: "POST",
          body: fd,
        });
        const json = (await res.json().catch(() => null)) as ApiResponse | null;
        if (!res.ok || !json?.success || !json.data || !json.resumeHtml) {
          setError(json?.error || "生成失败,请稍后重试。");
          return;
        }
        setResult(json.data);
        setPreserveHtml(json.resumeHtml);
        setResolvedJd(json.jdText ?? (jdMode === "text" ? jdText : ""));
        return;
      }

      // 经典模板流程:解析成结构化 JSON,再套固定模板渲染。
      const fd = new FormData();
      if (resumeMode === "file" && resumeFile) fd.append("resumeFile", resumeFile);
      else fd.append("resumeText", resumeText);
      if (jdMode === "file" && jdFile) fd.append("jdFile", jdFile);
      else fd.append("jdText", jdText);
      fd.append("tailorMode", tailorMode);
      if (tailorMode === "light") fd.append("allowRetitle", allowRetitle ? "true" : "false");

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
      setPreserving(false);
    }
  }

  // 保留原格式模式:简历 Word 直接下载「定制后仍保留原格式」的 HTML(以 .doc 打开保留大部分排版);
  // 否则走服务端按结构化结果生成的 .docx。
  function handleDownloadResumeWord() {
    if (preserveHtml) {
      const blob = new Blob([preserveHtml], { type: "application/msword" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${resumeFileBase}.doc`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    }
    void handleDownload("resume-docx");
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
    <>
      <header className="mt-2 mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          一键把简历改写成「为这份 JD 定制」
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          上传你的简历，再贴上目标岗位的 JD，AI 会按岗位重排经历、强化关键词，并生成求职信和匹配分析，导出 PDF / Word；生成后可直接带着这份简历去投递 Indeed。
        </p>
        {!isPublicDeploy && (
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
        )}
      </header>

      {/* 简历输入(默认已预填一份,可直接换掉) */}
      <SourceCard
        title="① 你的简历"
        mode={resumeMode}
        onMode={setResumeMode}
        file={resumeFile}
        onFile={(f) => {
          setResumeFile(f);
          setDefaultResumeLoaded(false);
        }}
        text={resumeText}
        onText={setResumeText}
        placeholder="把简历内容粘贴到这里……"
        accept={ACCEPT}
        hint={
          defaultResumeLoaded && resumeMode === "file"
            ? "已自动填入默认简历，直接换成别的文件即可覆盖。"
            : undefined
        }
      />

      {/* 保留原格式开关(仅上传文件时相关) */}
      {resumeMode === "file" && (
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={preserveFormat}
              onChange={(e) => setPreserveFormat(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
            />
            <span>
              <span className="text-sm font-medium text-slate-800">
                保留简历原格式（推荐 · 适用于上传的 Word .docx）
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                打开后：先把你的 .docx 高保真转成 HTML（字体 / 字号 / 颜色 / 版式都保留），AI 只在<b>原版式上按 JD 改写文字</b>（重排经历、强化关键词），<b>不套用固定模板</b>。整份改写较慢（约 3~4 分钟）。关闭则按经典模板重排（更快，但不保留你的原格式）。
              </span>
              {preserveBlocked && (
                <span className="mt-1 block text-xs leading-relaxed text-amber-600">
                  ⚠️ 当前文件不是 .docx，无法保留原格式；生成时会自动改用经典模板（PDF / 粘贴文本同理）。
                </span>
              )}
              {isPublicDeploy && (
                <span className="mt-1 block text-xs leading-relaxed text-slate-400">
                  线上单次请求上限 300 秒（已启用 Vercel Fluid），整份改写实测约 140 秒，放得下；
                  真遇到超时就关掉这个开关走经典模板（约 45 秒）。
                </span>
              )}
            </span>
          </label>
        </div>
      )}

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

      {/* 内容尺度:四档由弱到强,互斥,所以是单选而不是几个复选框 */}
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-slate-800">③ AI 改写的尺度</p>
        <div className="mt-3 space-y-2">
          {TAILOR_MODE_OPTIONS.map((opt) => (
            // 注意:子选项必须放在 radio 的 <label> **外面**。
            // 嵌在里面的话,点子选项会被外层 label 当成点 radio(自己踩过这个坑)。
            <div
              key={opt.value}
              className={`rounded-xl border p-3 transition ${
                tailorMode === opt.value
                  ? "border-cyan-300 bg-cyan-50/50"
                  : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="tailorMode"
                  value={opt.value}
                  checked={tailorMode === opt.value}
                  onChange={() => setTailorMode(opt.value)}
                  className="mt-1 h-4 w-4 border-slate-300 text-cyan-600 focus:ring-cyan-500"
                />
                <span>
                  <span className="text-sm font-medium text-slate-800">
                    {opt.label}
                    {opt.value === DEFAULT_TAILOR_MODE && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-500">
                        默认
                      </span>
                    )}
                  </span>
                  <span
                    className={`mt-1 block text-xs leading-relaxed ${
                      opt.warn ? "text-amber-600" : "text-slate-500"
                    }`}
                  >
                    {opt.desc}
                  </span>
                </span>
              </label>

              {/* 轻度激进的子选项:职位名要不要跟着 JD 挪。
                  原简历写 Java Backend 而 JD 偏前端时,职位名硬扛着反而更假。 */}
              {opt.value === "light" && tailorMode === "light" && (
                <label className="mt-2 ml-7 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-white p-2.5">
                  <input
                    type="checkbox"
                    name="allowRetitle"
                    checked={allowRetitle}
                    onChange={(e) => setAllowRetitle(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span>
                    <span className="text-xs font-medium text-slate-800">也允许调整职位名称</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                      原简历是「Java Backend」而 JD 偏前端 / 全栈时，职位名硬扛着不改反而更假。打开后 AI
                      可以把职位名往 JD 的方向挪一点（如
                      <b> Senior Software Engineer, Backend → …, Full Stack</b>）—— 但
                      <b>同一家公司、同一段日期、同一个职级</b>，不会借机升职或换成 Manager / Tech Lead
                      这类头衔。不打开则职位名一个字都不动。
                    </span>
                  </span>
                </label>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
      )}

      <button
        onClick={handleGenerate}
        disabled={loading}
        className="mt-5 w-full rounded-xl bg-cyan-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading
          ? preserving
            ? PRESERVE_HINTS[hintIndex % PRESERVE_HINTS.length]
            : LOADING_HINTS[hintIndex % LOADING_HINTS.length]
          : "生成定制简历"}
      </button>

      {/* 面试题库入口(只需①的简历,JD 可选;不必先定制简历)。
          题库要连数据库、出题约 1 分钟,公网部署上关掉:入口置灰 + 说明,middleware 里也真拦。 */}
      <div
        className={`mt-4 rounded-2xl border p-5 shadow-sm ${
          isPublicDeploy ? "border-slate-200 bg-slate-50" : "border-indigo-200 bg-indigo-50/50"
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p
              className={`text-sm font-semibold ${
                isPublicDeploy ? "text-slate-500" : "text-indigo-900"
              }`}
            >
              🧠 简历面试题库 · 遗忘曲线复习
            </p>
            <p
              className={`mt-1 text-xs leading-relaxed ${
                isPublicDeploy ? "text-slate-400" : "text-indigo-700"
              }`}
            >
              不改简历也行——用上面「① 你的简历」（JD 可选），我来当面试官，按你的简历出一套面试题（以概念 / 场景 / 系统设计等技术题为主，少量行为面试），你作答、AI 打分；每道题按遗忘曲线自动安排下次复习。题库绑定这份简历，进度自动保存。
            </p>
          </div>
          <button
            onClick={handleBuildBank}
            disabled={buildingBank || isPublicDeploy}
            className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
              isPublicDeploy ? "bg-slate-400" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {isPublicDeploy
              ? "线上暂未开放"
              : buildingBank
                ? "正在出题（约 1 分钟）…"
                : "用这份简历生成题库 →"}
          </button>
        </div>
        {isPublicDeploy ? (
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            🔒 这个功能只在 Andy 本地环境下开放，线上暂时 disable 了这个功能。
          </p>
        ) : (
          <label className="mt-3 flex items-center gap-2 text-xs text-indigo-700">
            <input
              type="checkbox"
              checked={rebuildBank}
              onChange={(e) => setRebuildBank(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
            />
            重新生成（覆盖这份简历的旧题库；出题需要约 1 分钟）
          </label>
        )}
        {bankError && <p className="mt-2 text-sm text-rose-600">{bankError}</p>}
      </div>

      {/* 结果 */}
      {result && (
        <div ref={resultRef} className="mt-10 space-y-6">
          {!isPublicDeploy && (
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
          )}

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
            onDownloadResumeWord={handleDownloadResumeWord}
            onDownload={handleDownload}
            downloading={downloading}
            preserveMode={!!preserveHtml}
            error={downloadError}
          />

          <ResumeHtmlPreview
            html={resumeHtml}
            frameRef={resumeFrameRef}
            preserveMode={!!preserveHtml}
          />
          <CoverLetterPreview text={result.coverLetter} />
        </div>
      )}
    </>
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
  hint,
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
  /** 文件框下面的一行小字说明(可选)。 */
  hint?: string;
}) {
  const [dragging, setDragging] = useState(false);

  // 拖入文件:只接受 PDF / DOCX,其它类型忽略(与点击选择的 accept 一致)
  function acceptDropped(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const name = f.name.toLowerCase();
    const okName = name.endsWith(".pdf") || name.endsWith(".docx");
    const okType =
      f.type === "application/pdf" ||
      f.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (okName || okType) onFile(f);
  }

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
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              acceptDropped(e.dataTransfer.files);
            }}
            className={`flex cursor-pointer items-center justify-center rounded-xl border border-dashed px-4 py-6 text-sm transition ${
              dragging
                ? "border-cyan-400 bg-cyan-50 text-cyan-700 ring-2 ring-cyan-200"
                : "border-slate-300 bg-slate-50 text-slate-500 hover:border-cyan-300 hover:bg-cyan-50/40"
            }`}
          >
            <input
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="font-medium text-slate-700">📄 {file.name}</span>
            ) : dragging ? (
              <span className="font-medium">松手即可上传</span>
            ) : (
              <span>点击选择，或把 PDF / DOCX 文件拖到这里</span>
            )}
          </label>
          {hint && <p className="mt-2 text-xs text-slate-400">{hint}</p>}
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
  onDownloadResumeWord,
  onDownload,
  downloading,
  preserveMode,
  error,
}: {
  onPrintResume: () => void;
  onDownloadResumeWord: () => void;
  onDownload: (k: DownloadKind) => void;
  downloading: DownloadKind | null;
  preserveMode: boolean;
  error: string | null;
}) {
  // 简历 Word 单独处理(保留原格式时走客户端下载);求职信 / 分析报告仍走服务端。
  const others: Array<{ kind: DownloadKind; label: string; icon: string }> = [
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
        <button
          onClick={onDownloadResumeWord}
          disabled={!preserveMode && downloading !== null}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-cyan-300 hover:bg-cyan-50/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span aria-hidden>📝</span>
          {!preserveMode && downloading === "resume-docx"
            ? "生成中…"
            : preserveMode
              ? "简历 Word（保留格式）"
              : "简历 Word"}
        </button>
        {others.map((b) => (
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
        {preserveMode && "「简历 Word（保留格式）」以 Word 打开会保留你原简历的大部分排版。"}
      </p>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}

function ResumeHtmlPreview({
  html,
  frameRef,
  preserveMode,
}: {
  html: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  preserveMode: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        改写后的简历（{preserveMode ? "保留原格式" : "经典模板"} · 下方即为打印 / PDF 效果）
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
