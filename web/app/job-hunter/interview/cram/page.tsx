"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ============================ 类型 ============================ */

type SrState = "new" | "learning" | "young" | "mastered";
type CramCardKind = "word" | "block" | "svg";

type WordExtra = { en?: string; ipa?: string; zh?: string; note?: string };

type CramCard = {
  id: number;
  kind: CramCardKind;
  front: string;
  content: string;
  svg: string;
  extra: WordExtra | null;
  state: SrState;
  isDue: boolean;
  dueAt: string | null;
};

type SessionMeta = { id: number; title: string; language: string; resumeHtml: string };
type CramSummary = { id: number; title: string; language: string; created_at: string; total: number; due: number };
type Diagram = { svg: string; caption: string; text: string };
type Candidate = Diagram & { passage: string; cid: number; adding?: boolean };

/* ============================ 常量 / 工具 ============================ */

const ACCEPT =
  ".docx,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html";

const SR_STATE_LABEL: Record<SrState, string> = { new: "新", learning: "学习中", young: "巩固中", mastered: "已掌握" };
const SR_STATE_CLASS: Record<SrState, string> = {
  new: "bg-sky-50 text-sky-600",
  learning: "bg-amber-50 text-amber-700",
  young: "bg-violet-50 text-violet-700",
  mastered: "bg-emerald-50 text-emerald-700",
};

const KIND_LABEL: Record<CramCardKind, string> = { word: "单词卡", block: "知识块", svg: "记忆图卡" };

function isDocx(file: File): boolean {
  return file.name.toLowerCase().endsWith(".docx") || file.type.includes("wordprocessingml");
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
    await renderAsync(buf, content, styleEl, { className: "docx", inWrapper: true, ignoreLastRenderedPageBreak: true });
    const css = styleEl.innerHTML;
    const bodyHtml = content.innerHTML;
    return `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${bodyHtml}</body></html>`;
  } finally {
    content.remove();
    styleEl.remove();
  }
}

async function fileToHtml(file: File): Promise<string> {
  if (isDocx(file)) return convertDocxToHtml(file);
  if (isHtml(file)) {
    const text = await file.text();
    if (!text.trim()) throw new Error("empty");
    return text;
  }
  throw new Error("unsupported");
}

/** 客户端剥掉脚本 / 事件处理器 / javascript: 链接(同文档渲染的卫生处理)。 */
function sanitizeBodyHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*("|')/gi, '$1="#"');
}

/** 把存好的整份 HTML 拆成 <style> 内容 + body 内容(供同文档阅读器渲染、可划词)。 */
function extractDocParts(html: string): { css: string; body: string } {
  if (typeof window === "undefined" || !html) return { css: "", body: "" };
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const css = Array.from(doc.querySelectorAll("style"))
      .map((s) => s.textContent || "")
      .join("\n");
    const body = doc.body ? doc.body.innerHTML : html;
    return { css, body: sanitizeBodyHtml(body) };
  } catch {
    return { css: "", body: sanitizeBodyHtml(html) };
  }
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function playTts(blob: Blob, ref: { current: HTMLAudioElement | null }) {
  const prev = ref.current;
  if (prev) {
    prev.pause();
    if (prev.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
  }
  const url = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = "auto";
  a.src = url;
  ref.current = a;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    a.currentTime = 0;
    a.play().catch(() => {});
  };
  a.addEventListener("canplay", start, { once: true });
  a.addEventListener("loadeddata", start, { once: true });
  a.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  a.load();
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; data: (T & { success: boolean }) | null; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) return { ok: false, data: null, error: json?.error || "请求失败" };
    return { ok: true, data: json };
  } catch {
    return { ok: false, data: null, error: "网络异常" };
  }
}

/* ============================ 页面壳:读 ?session= 决定「上传」还是「猛攻」 ============================ */

export default function CramPage() {
  const [sessionId, setSessionId] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    // 只在挂载时读一次(与题库页一致,避免 useSearchParams 的 Suspense 约束)。
    const sp = new URLSearchParams(window.location.search);
    const id = Number(sp.get("session"));
    setSessionId(Number.isInteger(id) && id > 0 ? id : null);
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
        <Link href="/job-hunter/interview" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回面试复习中心
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-600">
            对应简历猛攻版 · Resume Cram
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">按这份简历死磕到脱稿</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-500">
            上传一份简历 / 面试稿，划词翻译（按你简历的情景来译）、把要点加入知识块、选一大段生成 SVG
            记忆卡片，全部按遗忘曲线复习，还能随时追问。所有内容都存在数据库里，随时回来接着背。
          </p>
        </header>

        {sessionId === undefined ? (
          <p className="text-sm text-slate-400">正在加载……</p>
        ) : sessionId ? (
          <CramWorkspace sessionId={sessionId} />
        ) : (
          <CramUpload />
        )}
      </div>
    </main>
  );
}

/* ============================ 上传 + 选择已有简历 ============================ */

function CramUpload() {
  const [fileName, setFileName] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<CramSummary[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/job-hunter/interview/cram/sessions")
      .then((r) => r.json())
      .then((j) => setSessions(j?.success ? (j.sessions as CramSummary[]) : []))
      .catch(() => setSessions([]));
  }, []);

  async function handleFile(file: File | null) {
    setConvertError(null);
    setSubmitError(null);
    setHtml(null);
    if (!file) {
      setFileName("");
      return;
    }
    setFileName(file.name);
    if (!isDocx(file) && !isHtml(file)) {
      setConvertError("请上传 .docx 或 .html 文件（旧版 .doc 不支持）。");
      return;
    }
    setConverting(true);
    try {
      setHtml(await fileToHtml(file));
    } catch {
      setConvertError("转换失败，请换一份文件或另存为 .docx / .html 再试。");
    } finally {
      setConverting(false);
    }
  }

  async function submit() {
    if (!html) return;
    setSubmitting(true);
    setSubmitError(null);
    const r = await postJson<{ sessionId: number }>("/api/job-hunter/interview/cram/session", {
      resumeHtml: html,
      name: fileName,
    });
    if (r.ok && r.data) {
      // 整页跳转:本页挂载时才读一次 ?session=,软跳转不会重挂载。
      window.location.href = `/job-hunter/interview/cram?session=${r.data.sessionId}`;
    } else {
      setSubmitError(r.error || "上传失败");
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-slate-800">上传要猛攻的简历 / 面试稿</p>
        <label className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 px-4 py-8 text-center transition hover:border-emerald-300 hover:bg-emerald-50/30">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          <span className="text-3xl">📄</span>
          <span className="mt-2 text-sm text-slate-600">
            {fileName ? `已选择：${fileName}` : "点击选择 .docx 或 .html 文件"}
          </span>
          <span className="mt-1 text-xs text-slate-400">保留原格式渲染，供你逐句阅读、划词</span>
        </label>
        {converting && <p className="mt-3 text-sm text-slate-400">正在读取文档……</p>}
        {convertError && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{convertError}</p>}
        {submitError && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{submitError}</p>}
        {html && (
          <button
            onClick={submit}
            disabled={submitting}
            className="mt-4 w-full rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {submitting ? "创建中……" : "开始猛攻 →"}
          </button>
        )}
      </div>

      <CramSessionList sessions={sessions} />
    </div>
  );
}

function CramSessionList({ sessions }: { sessions: CramSummary[] | null }) {
  if (sessions === null) return <p className="text-sm text-slate-400">正在加载已上传的简历……</p>;
  if (sessions.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">或接着背之前上传的</p>
      <div className="mt-3 space-y-2">
        {sessions.map((s) => (
          <a
            key={s.id}
            href={`/job-hunter/interview/cram?session=${s.id}`}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3 transition hover:border-emerald-300 hover:bg-emerald-50/40"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-800">{s.title}</div>
              <div className="mt-0.5 text-xs text-slate-400">
                {s.total} 张卡 · 上传于 {String(s.created_at).slice(0, 10)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {s.due > 0 ? (
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600">{s.due} 待复习</span>
              ) : (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">已清空</span>
              )}
              <span className="text-sm text-emerald-500">继续 →</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

/* ============================ 猛攻工作台 ============================ */

function CramWorkspace({ sessionId }: { sessionId: number }) {
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [cards, setCards] = useState<CramCard[]>([]);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [ask, setAsk] = useState<{ passage: string; context: string } | null>(null);
  const [askSeq, setAskSeq] = useState(0); // 每次「追问」自增 → 作 key 让 AskPanel 重挂载(清掉上一段的问答)
  const askRef = useRef<HTMLDivElement | null>(null);
  const candidatesRef = useRef<HTMLDivElement | null>(null);
  const candSeqRef = useRef(0); // 给候选卡片发稳定 id,避免用数组下标删错

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const loadCards = useCallback(async () => {
    try {
      const res = await fetch(`/api/job-hunter/interview/cram/card?sessionId=${sessionId}`);
      const j = await res.json().catch(() => null);
      if (j?.success) setCards(j.items as CramCard[]);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/job-hunter/interview/cram/session?id=${sessionId}`);
        const j = await res.json().catch(() => null);
        if (j?.success) setSession(j.session as SessionMeta);
        else setSessionError(j?.error || "加载失败");
      } catch {
        setSessionError("网络异常");
      }
    })();
    loadCards();
  }, [sessionId, loadCards]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const speak = useCallback(async (text: string) => {
    if (!text) return;
    try {
      setSpeaking(true);
      const r = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.ok) playTts(await r.blob(), audioRef);
    } catch {
      /* ignore */
    } finally {
      setSpeaking(false);
    }
  }, []);

  const docParts = useMemo(() => extractDocParts(session?.resumeHtml || ""), [session?.resumeHtml]);

  async function handleGenerate(passage: string, context: string) {
    setGenError(null);
    setGenerating(true);
    setTimeout(() => candidatesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    const r = await postJson<{ diagrams: Diagram[] }>("/api/job-hunter/interview/cram/svg", { passage, context });
    if (r.ok && r.data) {
      const fresh = (r.data.diagrams as Diagram[]).map((d) => ({ ...d, passage, cid: ++candSeqRef.current }));
      setCandidates((prev) => [...fresh, ...prev]);
    } else {
      setGenError(r.error || "生成失败");
    }
    setGenerating(false);
  }

  function handleAsk(passage: string, context: string) {
    setAsk({ passage, context });
    setAskSeq((s) => s + 1);
    setTimeout(() => askRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  async function addCandidate(cid: number) {
    const cand = candidates.find((c) => c.cid === cid);
    if (!cand) return;
    setCandidates((prev) => prev.map((c) => (c.cid === cid ? { ...c, adding: true } : c)));
    const r = await postJson<{ id: number }>("/api/job-hunter/interview/cram/card", {
      sessionId,
      kind: "svg",
      content: cand.caption,
      svg: cand.svg,
    });
    if (r.ok) {
      setCandidates((prev) => prev.filter((c) => c.cid !== cid));
      loadCards();
    } else {
      setCandidates((prev) => prev.map((c) => (c.cid === cid ? { ...c, adding: false } : c)));
    }
  }

  if (sessionError) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
        {sessionError}
        <div className="mt-3">
          <Link href="/job-hunter/interview/cram" className="font-semibold text-emerald-600 underline">
            重新上传一份
          </Link>
        </div>
      </div>
    );
  }
  if (!session) return <p className="text-sm text-slate-400">正在加载简历……</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">📄 {session.title}</p>
          <p className="text-xs text-slate-400">划词翻译按简历情景来；选一大段可生成记忆卡片</p>
        </div>
        <Link href="/job-hunter/interview/cram" className="shrink-0 text-xs text-emerald-600 hover:underline">
          ＋ 换一份简历
        </Link>
      </div>

      {/* 遗忘曲线复习 */}
      <CramReview
        sessionId={sessionId}
        cards={cards}
        onReload={loadCards}
        speak={speak}
        speaking={speaking}
      />

      {/* 阅读 + 划词 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-2 text-xs font-semibold text-slate-500">
          📖 阅读区（选中词 = 翻译并可加入单词卡；选中一整段 = 加入知识块 / 生成记忆图卡 / 追问）
        </p>
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-100 bg-slate-50/40 p-2">
          <CramSelectable
            sessionId={sessionId}
            className="cram-reader"
            onChanged={loadCards}
            onGenerate={handleGenerate}
            onAsk={handleAsk}
          >
            <style dangerouslySetInnerHTML={{ __html: docParts.css }} />
            <div dangerouslySetInnerHTML={{ __html: docParts.body }} />
          </CramSelectable>
        </div>
      </div>

      {/* 追问面板(key=askSeq:每次追问都重挂载,清掉上一段的问答) */}
      {ask && <AskPanel key={askSeq} ref={askRef} sessionId={sessionId} ask={ask} onClose={() => setAsk(null)} onSaved={loadCards} />}

      {/* 生成的记忆卡片候选 */}
      <div ref={candidatesRef}>
        {(generating || candidates.length > 0 || genError) && (
          <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
            <p className="text-xs font-semibold text-violet-700">🎨 生成的记忆卡片（点「加入」纳入遗忘曲线）</p>
            {generating && <p className="mt-2 text-sm text-slate-500">正在生成记忆卡片，可能要十几秒到一分钟……</p>}
            {genError && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{genError}</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {candidates.map((c) => (
                <div key={c.cid} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="overflow-x-auto">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={svgDataUri(c.svg)} alt={c.caption || "记忆卡片"} className="mx-auto max-w-full" />
                  </div>
                  {c.caption && <p className="mt-1 text-xs text-slate-500">{c.caption}</p>}
                  <button
                    onClick={() => addCandidate(c.cid)}
                    disabled={c.adding}
                    className="mt-2 rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-600 transition hover:bg-violet-50 disabled:opacity-60"
                  >
                    {c.adding ? "加入中…" : "➕ 加入这张"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 卡片清单 */}
      <CramCardList cards={cards} onReload={loadCards} />
    </div>
  );
}

/* ============================ 复习面板 ============================ */

function CramReview({
  sessionId,
  cards,
  onReload,
  speak,
  speaking,
}: {
  sessionId: number;
  cards: CramCard[];
  onReload: () => void;
  speak: (t: string) => void;
  speaking: boolean;
}) {
  const [queue, setQueue] = useState<CramCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      total: cards.length,
      due: cards.filter((c) => c.isDue).length,
      fresh: cards.filter((c) => c.state === "new").length,
      mastered: cards.filter((c) => c.state === "mastered").length,
    }),
    [cards],
  );

  function start() {
    const q = cards.filter((c) => c.isDue);
    if (!q.length) {
      setMsg("今日没有到期的卡片 🎉");
      return;
    }
    setQueue(q);
    setIdx(0);
    setRevealed(false);
    setLastLabel(null);
    setMsg(null);
  }

  const cur = queue.length > 0 ? queue[idx] : null;
  const needsReveal = cur ? (cur.kind === "word" ? true : cur.kind === "block" ? !!cur.front : false) : false;
  const showBack = revealed || !needsReveal;

  async function grade(g: "forgot" | "vague" | "clear") {
    if (!cur) return;
    setGrading(true);
    const label = cur.kind === "word" ? cur.front || cur.content : cur.front || cur.content.slice(0, 18) || "卡片";
    const r = await postJson<{ nextReviewLabel: string }>("/api/job-hunter/interview/cram/card/review", { id: cur.id, grade: g });
    setLastLabel(r.ok && r.data ? `${label} → ${r.data.nextReviewLabel}复习` : null);
    setGrading(false);
    if (idx + 1 >= queue.length) {
      setQueue([]);
      setIdx(0);
      setRevealed(false);
      setMsg("本轮复习完成 🎉");
      onReload();
    } else {
      setIdx(idx + 1);
      setRevealed(false);
    }
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-emerald-900">🧠 遗忘曲线复习</p>
        <span className="text-xs text-slate-400">共 {counts.total} 张</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat label="今日到期" value={counts.due} tone="rose" />
        <Stat label="新卡" value={counts.fresh} tone="sky" />
        <Stat label="已掌握" value={counts.mastered} tone="emerald" />
        <Stat label="总数" value={counts.total} tone="slate" />
      </div>

      {msg && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      {cur ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-slate-400">
              第 {idx + 1} / {queue.length} 张
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[cur.state]}`}>
              {KIND_LABEL[cur.kind]} · {SR_STATE_LABEL[cur.state]}
            </span>
          </div>
          <CramFlashcard card={cur} showBack={showBack} sessionId={sessionId} speak={speak} speaking={speaking} onChanged={onReload} />
          {!showBack ? (
            <button
              onClick={() => setRevealed(true)}
              className="mt-4 w-full rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-900"
            >
              {cur.kind === "word" ? "👀 显示释义" : "👀 显示内容"}
            </button>
          ) : (
            <div className="mt-4 grid grid-cols-3 gap-2">
              <button
                onClick={() => grade("forgot")}
                disabled={grading}
                className="rounded-xl border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-60"
              >
                不记得
              </button>
              <button
                onClick={() => grade("vague")}
                disabled={grading}
                className="rounded-xl border border-amber-200 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-60"
              >
                似乎记得
              </button>
              <button
                onClick={() => grade("clear")}
                disabled={grading}
                className="rounded-xl border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-60"
              >
                清楚
              </button>
            </div>
          )}
          {lastLabel && <p className="mt-2 text-center text-xs text-slate-400">{lastLabel}</p>}
        </div>
      ) : (
        <button
          onClick={start}
          disabled={counts.due === 0}
          className="mt-4 w-full rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {counts.due === 0 ? "今日无到期卡片 🎉" : `开始复习（${counts.due} 张到期）`}
        </button>
      )}
    </div>
  );
}

function CramFlashcard({
  card,
  showBack,
  sessionId,
  speak,
  speaking,
  onChanged,
}: {
  card: CramCard;
  showBack: boolean;
  sessionId: number;
  speak: (t: string) => void;
  speaking: boolean;
  onChanged: () => void;
}) {
  if (card.kind === "word") {
    const en = card.extra?.en || card.front;
    const ipa = card.extra?.ipa || "";
    const zh = card.extra?.zh || card.content;
    const note = card.extra?.note || "";
    return (
      <>
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-800">{card.front}</span>
          {ipa && <span className="text-xs text-slate-500">{ipa}</span>}
          <button
            onClick={() => speak(en)}
            disabled={speaking}
            title="发音"
            className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 transition hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50"
          >
            {speaking ? "…" : "🔊"}
          </button>
        </div>
        {showBack && (
          <div className="mt-2">
            <div className="text-sm text-slate-700">{zh}</div>
            {note && <div className="mt-0.5 text-xs text-slate-400">{note}</div>}
          </div>
        )}
      </>
    );
  }

  if (card.kind === "svg") {
    return (
      <>
        <div className="overflow-x-auto rounded-lg border border-slate-100 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={svgDataUri(card.svg)} alt={card.content || "记忆卡片"} className="mx-auto max-w-full" />
        </div>
        {card.content && (
          <CramSelectable sessionId={sessionId} text={card.content} className="mt-1 text-xs text-slate-500" onChanged={onChanged} />
        )}
      </>
    );
  }

  // block
  return (
    <>
      {card.front && <div className="text-base font-semibold text-slate-800">{card.front}</div>}
      {showBack && card.content && (
        <CramSelectable
          sessionId={sessionId}
          text={card.content}
          className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700"
          onChanged={onChanged}
        />
      )}
    </>
  );
}

/* ============================ 追问面板 ============================ */

const AskPanel = ({
  ref,
  sessionId,
  ask,
  onClose,
  onSaved,
}: {
  ref: React.Ref<HTMLDivElement>;
  sessionId: number;
  ask: { passage: string; context: string };
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [q, setQ] = useState("");
  const [askedQ, setAskedQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");

  async function submit() {
    if (!q.trim()) return;
    setAsking(true);
    setErr(null);
    setAnswer(null);
    setSaved("idle");
    const frozen = q.trim();
    setAskedQ(frozen);
    const r = await postJson<{ answer: string }>("/api/job-hunter/interview/cram/ask", {
      passage: ask.passage,
      context: ask.context,
      question: frozen,
    });
    if (r.ok && r.data) setAnswer(r.data.answer);
    else setErr(r.error || "追问失败");
    setAsking(false);
  }

  async function saveAsBlock() {
    if (!answer) return;
    setSaved("saving");
    const r = await postJson<{ id: number }>("/api/job-hunter/interview/cram/card", {
      sessionId,
      kind: "block",
      front: askedQ,
      content: answer,
    });
    if (r.ok) {
      setSaved("saved");
      onSaved();
    } else {
      setSaved("idle");
    }
  }

  return (
    <div ref={ref} className="rounded-2xl border border-sky-200 bg-sky-50/40 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-sky-700">💬 追问这段</p>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
          收起 ✕
        </button>
      </div>
      <div className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-sky-100 bg-white p-2 text-xs leading-relaxed text-slate-600">
        {ask.passage.length > 400 ? ask.passage.slice(0, 400) + "…" : ask.passage}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit();
          }}
          placeholder="比如：这段怎么说更自然？面试官会怎么追问？"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-400"
        />
        <button
          onClick={submit}
          disabled={asking || !q.trim()}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
        >
          {asking ? "思考中…" : "问"}
        </button>
      </div>
      {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</p>}
      {answer && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{answer}</p>
          <div className="mt-2">
            {saved === "saved" ? (
              <span className="text-xs font-medium text-violet-600">✓ 已存成知识块</span>
            ) : (
              <button
                onClick={saveAsBlock}
                disabled={saved === "saving"}
                className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-600 transition hover:bg-violet-50 disabled:opacity-60"
              >
                {saved === "saving" ? "保存中…" : "➕ 存成知识块（进遗忘曲线）"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================ 卡片清单 ============================ */

function CramCardList({ cards, onReload }: { cards: CramCard[]; onReload: () => void }) {
  async function remove(id: number) {
    await fetch(`/api/job-hunter/interview/cram/card?id=${id}`, { method: "DELETE" });
    onReload();
  }
  if (!cards.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
        还没有卡片。去上面的阅读区划词、加入知识块，或选一整段生成记忆卡片吧。
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">全部卡片（{cards.length}）</p>
      <div className="mt-3 space-y-1.5">
        {cards.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs text-slate-400">{c.kind === "svg" ? "📊" : c.kind === "word" ? "🔤" : "🧠"}</span>
              <span className="truncate text-sm text-slate-700">
                {c.front || c.content || (c.kind === "svg" ? "（图示）" : "")}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[c.state]}`}>
                {SR_STATE_LABEL[c.state]}
              </span>
              <button onClick={() => remove(c.id)} className="text-xs text-slate-400 hover:text-rose-500">
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ 划词组件(阅读器 + 复习卡背面共用) ============================ */

function CramSelectable({
  sessionId,
  text,
  children,
  className,
  onChanged,
  onGenerate,
  onAsk,
}: {
  sessionId: number;
  text?: string;
  children?: ReactNode;
  className?: string;
  onChanged?: () => void;
  onGenerate?: (passage: string, context: string) => void;
  onAsk?: (passage: string, context: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const termAudioRef = useRef<HTMLAudioElement | null>(null);
  const reqIdRef = useRef(0);

  const [pop, setPop] = useState<{ x: number; y: number; term: string; context: string; isBlock: boolean; below: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<{ en: string; ipa: string; zh: string; note: string } | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [word, setWord] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [block, setBlock] = useState<"idle" | "adding" | "added" | "error">("idle");

  useEffect(() => () => termAudioRef.current?.pause(), []);

  /** 从选区锚点向上找最近的块级元素文本,作为「简历情景」上下文;拿不到就退回整块文本。 */
  function contextFor(anchor: Node | null): string {
    if (typeof text === "string") return text.slice(0, 800);
    let el: Element | null = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
    while (el && el !== ref.current) {
      if (/^(P|LI|TR|TD|TH|DIV|SECTION|H1|H2|H3|H4|H5|BLOCKQUOTE|ARTICLE)$/.test(el.tagName)) {
        const txt = (el.textContent || "").trim();
        if (txt.length >= 20) return txt.slice(0, 800);
      }
      el = el.parentElement;
    }
    return (ref.current?.textContent || "").slice(0, 800);
  }

  function onMouseUp() {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) return;
    const term = sel.toString().trim();
    if (!term || term.length > 4000) return;
    if (!ref.current || !ref.current.contains(sel.anchorNode)) return;
    let rect: DOMRect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    const context = contextFor(sel.anchorNode);
    const isBlock = term.length > 80;
    // 每次选择都自增:既做翻译请求的竞态守卫,也让挂起的「加入」回填失效(见 addWord/addBlock)。
    const rid = ++reqIdRef.current;
    // 选区靠近视口底部时,浮层放到选区「上方」,避免按钮被挤出屏幕点不到。
    const below = window.innerHeight - rect.bottom > 240;
    setPop({ x: rect.left + rect.width / 2, y: below ? rect.bottom : rect.top, term, context, isBlock, below });
    setRes(null);
    setWord("idle");
    setBlock("idle");
    if (isBlock) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch("/api/job-hunter/interview/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: term, context: context.slice(0, 1500) }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (rid !== reqIdRef.current) return;
        setRes(
          j?.success
            ? { en: j.en || "", ipa: j.ipa || "", zh: j.zh, note: j.note || "" }
            : { en: "", ipa: "", zh: "翻译失败", note: "" },
        );
      })
      .catch(() => {
        if (rid === reqIdRef.current) setRes({ en: "", ipa: "", zh: "网络异常", note: "" });
      })
      .finally(() => {
        if (rid === reqIdRef.current) setLoading(false);
      });
  }

  async function speakTerm(t: string) {
    try {
      setSpeaking(true);
      const r = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      if (r.ok) playTts(await r.blob(), termAudioRef);
    } catch {
      /* ignore */
    } finally {
      setSpeaking(false);
    }
  }

  async function addWord() {
    if (!pop) return;
    const rid = reqIdRef.current; // 记住当前选区;若中途换了选区就别把成功态回填到别的词
    setWord("adding");
    const r = await postJson<{ id: number }>("/api/job-hunter/interview/cram/card", {
      sessionId,
      kind: "word",
      front: pop.term,
      content: res?.zh || pop.term,
      extra: { en: res?.en || "", ipa: res?.ipa || "", zh: res?.zh || "", note: res?.note || "" },
    });
    if (r.ok) onChanged?.();
    if (rid !== reqIdRef.current) return; // 选区已变,丢弃这次的 UI 回填
    setWord(r.ok ? "added" : "error");
  }

  async function addBlock() {
    if (!pop) return;
    const rid = reqIdRef.current;
    setBlock("adding");
    const r = await postJson<{ id: number }>("/api/job-hunter/interview/cram/card", {
      sessionId,
      kind: "block",
      content: pop.term,
    });
    if (r.ok) onChanged?.();
    if (rid !== reqIdRef.current) return;
    setBlock(r.ok ? "added" : "error");
  }

  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      setPop(null);
    };
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [pop]);

  const enReading = res?.en?.trim() || "";
  const sameAsTerm = pop ? enReading.toLowerCase() === pop.term.trim().toLowerCase() : false;

  return (
    <>
      <div ref={ref} onMouseUp={onMouseUp} className={className}>
        {children ?? text}
      </div>
      {pop &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              left: pop.x,
              top: pop.below ? pop.y + 8 : pop.y - 8,
              transform: pop.below ? "translateX(-50%)" : "translate(-50%, -100%)",
              zIndex: 60,
              maxWidth: 340,
            }}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg"
          >
            {pop.isBlock ? (
              <div>
                <p className="text-xs font-semibold text-violet-700">选中了一整段</p>
                <div className="mt-1 max-h-28 max-w-[320px] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                  {pop.term.length > 300 ? pop.term.slice(0, 300) + "…" : pop.term}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{pop.term}</span>
                  {res?.ipa && (sameAsTerm || !enReading) && <span className="text-xs text-slate-500">{res.ipa}</span>}
                  <button
                    onClick={() => speakTerm(enReading || pop.term)}
                    disabled={speaking}
                    title="发音"
                    className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 transition hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50"
                  >
                    {speaking ? "…" : "🔊"}
                  </button>
                </div>
                {enReading && !sameAsTerm && (
                  <div className="mt-0.5 text-xs text-slate-500">
                    读作 <span className="font-medium text-slate-700">{enReading}</span>
                    {res?.ipa && <span className="ml-1 text-slate-500">{res.ipa}</span>}
                  </div>
                )}
                {loading ? (
                  <div className="mt-1 text-xs text-slate-400">翻译中…</div>
                ) : res ? (
                  <div className="mt-1">
                    <div className="text-sm text-slate-700">{res.zh}</div>
                    {res.note && <div className="mt-0.5 text-xs text-slate-400">{res.note}</div>}
                  </div>
                ) : null}
              </>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
              {!pop.isBlock &&
                res &&
                (word === "added" ? (
                  <span className="text-xs font-medium text-emerald-600">✓ 已加入单词卡</span>
                ) : (
                  <button
                    onClick={addWord}
                    disabled={word === "adding"}
                    className="rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60"
                  >
                    {word === "adding" ? "加入中…" : word === "error" ? "重试" : "➕ 加入单词卡"}
                  </button>
                ))}
              {block === "added" ? (
                <span className="text-xs font-medium text-violet-600">✓ 已加入知识块</span>
              ) : (
                <button
                  onClick={addBlock}
                  disabled={block === "adding"}
                  className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-600 transition hover:bg-violet-50 disabled:opacity-60"
                >
                  {block === "adding" ? "加入中…" : block === "error" ? "重试" : "🧠 加入知识块"}
                </button>
              )}
              {pop.isBlock && onGenerate && (
                <button
                  onClick={() => {
                    onGenerate(pop.term, pop.context);
                    setPop(null);
                  }}
                  className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-600 transition hover:bg-violet-50"
                >
                  🎨 生成记忆图卡
                </button>
              )}
              {onAsk && (
                <button
                  onClick={() => {
                    onAsk(pop.term, pop.context);
                    setPop(null);
                  }}
                  className="rounded-lg border border-sky-200 px-2.5 py-1 text-xs font-medium text-sky-600 transition hover:bg-sky-50"
                >
                  💬 追问
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ============================ 小组件 ============================ */

function Stat({ label, value, tone }: { label: string; value: number; tone: "rose" | "sky" | "slate" | "emerald" }) {
  const cls = { rose: "text-rose-600", sky: "text-sky-600", slate: "text-slate-600", emerald: "text-emerald-600" }[tone];
  return (
    <div className="rounded-xl bg-white/70 py-2">
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
