"use client";

import Link from "next/link";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  CRAM_BLOCK_CATEGORIES,
  CRAM_CATEGORIES,
  CRAM_CATEGORY_META,
  isCramBlockCategory,
  type CramBlockCategory,
  type CramCategory,
} from "@/lib/job-hunter/interview/cramCategory";
import { type Followup } from "@/lib/job-hunter/interview/followups";
import { frontKey } from "@/lib/job-hunter/interview/frontKey";
import { splitFencedBlocks } from "@/lib/job-hunter/interview/projectAnswer";

/**
 * 划词组件的「动作总线」:追问 / 生成记忆图卡 交给工作台的共享面板处理。
 * 工作台在最外层 Provider 一次,里面任何 CramSelectable(阅读区 / 复习卡背面 / 展开的卡片 / 追问答案)
 * 都自动带上全部动作,无需逐处接线。
 */
const CramActions = createContext<{
  onAsk?: (passage: string, context: string) => void;
  onGenerate?: (passage: string, context: string) => void;
}>({});

/**
 * 卡片内部的「就地追问」总线:回答里的代码块(CodeEvidence,埋在 AnswerBody 里)点「追问」时,
 * 把这段代码交给同一张卡底部的追问区。和上面的 CramActions 分开 —— 那个是把选中的文字送去
 * 工作台的共享面板(会新起一段问答),这个刻意**不离开这张卡**。
 */
const CardAsk = createContext<{ askAbout?: (snippet: string, ref: string) => void }>({});

/* ============================ 类型 ============================ */

type SrState = "new" | "learning" | "young" | "mastered";
type CramCardKind = "word" | "block" | "svg";

type WordExtra = { en?: string; ipa?: string; zh?: string; note?: string };

type CramCard = {
  id: number;
  kind: CramCardKind;
  /** 来源分类:追问 / 题库导入 / 单词 / 划词知识块 / Coding 题 / 记忆图卡。 */
  category: CramCategory;
  front: string;
  content: string;
  svg: string;
  extra: WordExtra | null;
  /** 「结合我的项目」的简历版回答(空 = 还没生成);与 content(原答案)分开存,原答案不动。 */
  projectAnswer: string;
  /** 就地追问的问答(存在这张卡里,复习时跟着看)。 */
  followups: Followup[];
  state: SrState;
  isDue: boolean;
  dueAt: string | null;
};

type SessionMeta = {
  id: number;
  title: string;
  language: string;
  resumeHtml: string;
  /** 「结合我的项目」默认讲哪个项目(空 = 让 AI 按题自己挑)。 */
  preferredProject: string;
  /** 代码佐证用的本机代码库绝对路径(空 = 回答里不带代码块)。 */
  codePath: string;
};
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

/** 「换卡自动念题」开关记在本地(默认开) */
const AUTO_READ_KEY = "cram:autoRead";

/** 题面的短版本号:文字改了 → 版本号变 → 绕开浏览器缓存重新取音频(djb2) */
function textVersion(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把粘贴的一大段纯文本转成简单 HTML(按空行分段、保留换行),供阅读器渲染 + 划词。 */
function textToHtml(text: string): string {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const css =
    '.cram-paste{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.75;color:#1e293b;max-width:820px;margin:0 auto;padding:24px 28px;background:#fff}.cram-paste p{margin:0 0 12px}';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="cram-paste">${paras || "<p></p>"}</div></body></html>`;
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

/** 把新材料并进已有的整份 HTML:合并 <style>(去重)、body 之间插一条带标签的分隔线。 */
function appendDoc(existingHtml: string, newHtml: string, label: string): string {
  const a = extractDocParts(existingHtml);
  const b = extractDocParts(newHtml);
  const css = Array.from(new Set([a.css, b.css].filter(Boolean))).join("\n");
  const sep = `<div style="margin:28px 0 14px;padding-top:14px;border-top:2px dashed #cbd5e1;color:#64748b;font-size:12px;font-weight:600">＋ 追加：${escapeHtml(label || "复习资料")}</div>`;
  const body = `${a.body}${sep}${b.body}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
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

async function postJson<T>(
  url: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<{ ok: boolean; data: (T & { success: boolean }) | null; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  const [pasted, setPasted] = useState("");
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
    setPasted(""); // 选了文件就清空粘贴框(二者取其一)
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

  function onPaste(v: string) {
    setPasted(v);
    setSubmitError(null);
    if (v.trim()) {
      // 开始粘贴就清掉已选文件(二者取其一)
      setHtml(null);
      setFileName("");
      setConvertError(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const canSubmit = !!html || pasted.trim().length > 0;

  async function submit() {
    const resumeHtml = html ?? (pasted.trim() ? textToHtml(pasted) : null);
    if (!resumeHtml) return;
    setSubmitting(true);
    setSubmitError(null);
    const r = await postJson<{ sessionId: number }>("/api/job-hunter/interview/cram/session", {
      resumeHtml,
      name: fileName, // 粘贴时为空,后端会用正文首行当标题
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
        <p className="text-sm font-semibold text-slate-800">粘贴或上传要猛攻的简历 / 面试稿 / 复习资料</p>

        {/* 方式一:直接粘贴一大段文本 */}
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-slate-500">✍️ 直接粘贴文本（复习资料、面试稿……）</label>
          <textarea
            value={pasted}
            onChange={(e) => onPaste(e.target.value)}
            rows={7}
            placeholder="把你的复习资料整段粘贴到这里，然后就能在下面阅读区里划词翻译、加入知识块、选一大段生成记忆卡片、随时追问。"
            className="w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm leading-relaxed outline-none focus:border-emerald-400"
          />
        </div>

        <div className="my-3 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-100" />
          或
          <span className="h-px flex-1 bg-slate-100" />
        </div>

        {/* 方式二:上传文件 */}
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-center transition hover:border-emerald-300 hover:bg-emerald-50/30">
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
        {canSubmit && (
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

  const [adding, setAdding] = useState(false); // 「＋ 添加复习资料」面板开关
  const [importOpen, setImportOpen] = useState(false); // 「📊 导入题库(Excel)」面板开关
  const [editing, setEditing] = useState(false); // 阅读区「编辑文本」模式
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editRef = useRef<HTMLDivElement | null>(null);
  const [ask, setAsk] = useState<{ passage: string; context: string } | null>(null);
  const [askSeq, setAskSeq] = useState(0); // 每次「追问」自增 → 作 key 让 AskPanel 重挂载(清掉上一段的问答)
  const askRef = useRef<HTMLDivElement | null>(null);
  const candidatesRef = useRef<HTMLDivElement | null>(null);
  const candSeqRef = useRef(0); // 给候选卡片发稳定 id,避免用数组下标删错

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);

  // 按来源挑一类复习(复习面板 + 卡片清单共用)。刻意不记进 localStorage:
  // 下次打开还停在某一类上,会让人以为卡片少了。
  const [category, setCategory] = useState<CatFilter>("all");

  // 「学习这张」:清单里点某张卡 → 把它插进复习面板的队列(seq 每次自增,同一张也能再点一次)。
  const [studyReq, setStudyReq] = useState<{ id: number; seq: number } | null>(null);
  const studySeq = useRef(0);
  const studyCard = useCallback((card: CramCard) => {
    studySeq.current += 1;
    setStudyReq({ id: card.id, seq: studySeq.current });
  }, []);

  // 已有题目的去重键(只看问答闪卡),给导入面板预检「这批里有几道已经有了」。
  const existingQuestionKeys = useMemo(() => {
    const s = new Set<string>();
    for (const c of cards) {
      if (c.kind !== "block" || !c.front) continue;
      const k = frontKey(c.front);
      if (k) s.add(k);
    }
    return s;
  }, [cards]);

  // 上一次加载见过哪些卡:用来发现「刚加进来的卡不在当前筛选里」。
  const knownIdsRef = useRef<Set<number> | null>(null);
  const loadCards = useCallback(async () => {
    try {
      const res = await fetch(`/api/job-hunter/interview/cram/card?sessionId=${sessionId}`);
      const j = await res.json().catch(() => null);
      if (!j?.success) return;
      const items = j.items as CramCard[];
      setCards(items);
      // 正筛着某一类时新加/导入的卡如果不属于这一类,清单和统计都不会动,看着像没保存 ——
      // 这种时候自动跳回「全部」,让新卡露出来。新卡里有属于当前分类的就不动。
      const known = knownIdsRef.current;
      knownIdsRef.current = new Set(items.map((c) => c.id));
      if (known) {
        const fresh = items.filter((c) => !known.has(c.id));
        if (fresh.length) {
          setCategory((cat) => (cat === "all" || fresh.some((c) => c.category === cat) ? cat : "all"));
        }
      }
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

  function startEdit() {
    setAdding(false);
    setEditError(null);
    setEditing(true);
  }

  async function saveEdit() {
    const div = editRef.current;
    if (!div) {
      setEditing(false);
      return;
    }
    // 读回用户改后的 body、清洗脚本/事件、用原样式重新组装整份 HTML 存回。
    const newBody = sanitizeBodyHtml(div.innerHTML);
    const merged = `<!doctype html><html><head><meta charset="utf-8"><style>${docParts.css}</style></head><body>${newBody}</body></html>`;
    setSavingEdit(true);
    setEditError(null);
    const r = await postJson("/api/job-hunter/interview/cram/session", { id: sessionId, resumeHtml: merged }, "PUT");
    if (r.ok) {
      setSession((s) => (s ? { ...s, resumeHtml: merged } : s));
      setEditing(false);
    } else {
      setEditError(r.error || "保存失败");
    }
    setSavingEdit(false);
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
    <CramActions.Provider value={{ onAsk: handleAsk, onGenerate: handleGenerate }}>
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">📄 {session.title}</p>
          <p className="text-xs text-slate-400">划词翻译按简历情景来；选一大段可生成记忆卡片</p>
          <SessionTextSetting
            sessionId={sessionId}
            field="preferredProject"
            label="🧩 简历版回答默认讲"
            empty="（不指定，AI 按题自己挑）"
            placeholder="例：Visa Token Service（留空=AI 按题自己挑）"
            value={session.preferredProject}
            onSaved={(v) => setSession((s) => (s ? { ...s, preferredProject: v } : s))}
          />
          <SessionTextSetting
            sessionId={sessionId}
            field="codePath"
            label="📂 代码佐证取自"
            empty="（没配代码库，回答里不带代码）"
            placeholder="代码库绝对路径，例：/Users/…/payment-token-service"
            wide
            value={session.codePath}
            onSaved={(v) => setSession((s) => (s ? { ...s, codePath: v } : s))}
          />
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
        studyReq={studyReq}
        category={category}
        onCategoryChange={setCategory}
      />

      {/* 阅读 + 划词 / 编辑 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-start justify-between gap-3">
          <p className="text-xs font-semibold text-slate-500">
            {editing
              ? "✏️ 编辑模式：直接在下面改文本，改完点「保存」"
              : "📖 阅读区（选中词 = 翻译并可加入单词卡；选中一整段 = 加入知识块 / 生成记忆图卡 / 追问）"}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={saveEdit}
                  disabled={savingEdit}
                  className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
                >
                  {savingEdit ? "保存中…" : "保存"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  disabled={savingEdit}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={startEdit}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                >
                  ✏️ 编辑文本
                </button>
                <button
                  onClick={() => {
                    setAdding(false);
                    setImportOpen((v) => !v);
                  }}
                  className="rounded-lg border border-sky-200 px-2.5 py-1 text-xs font-medium text-sky-600 transition hover:bg-sky-50"
                >
                  {importOpen ? "收起" : "📊 导入题库(Excel)"}
                </button>
                <button
                  onClick={() => {
                    setImportOpen(false);
                    setAdding((v) => !v);
                  }}
                  className="rounded-lg border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50"
                >
                  {adding ? "收起" : "＋ 添加复习资料"}
                </button>
              </>
            )}
          </div>
        </div>
        {editError && <p className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{editError}</p>}
        {importOpen && !editing && (
          <ImportExcel sessionId={sessionId} existingKeys={existingQuestionKeys} onImported={loadCards} />
        )}
        {adding && !editing && (
          <AddMaterial
            sessionId={sessionId}
            currentHtml={session.resumeHtml}
            onUpdated={(mergedHtml) => {
              setSession((s) => (s ? { ...s, resumeHtml: mergedHtml } : s));
              setAdding(false);
            }}
          />
        )}
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-100 bg-slate-50/40 p-2">
          {editing ? (
            <>
              <style dangerouslySetInnerHTML={{ __html: docParts.css }} />
              <div
                ref={editRef}
                contentEditable
                suppressContentEditableWarning
                className="cram-reader min-h-[240px] rounded-lg outline-none ring-2 ring-emerald-200 focus:ring-emerald-400"
                dangerouslySetInnerHTML={{ __html: docParts.body }}
              />
            </>
          ) : (
            <CramSelectable sessionId={sessionId} className="cram-reader" onChanged={loadCards}>
              <style dangerouslySetInnerHTML={{ __html: docParts.css }} />
              <div dangerouslySetInnerHTML={{ __html: docParts.body }} />
            </CramSelectable>
          )}
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
      <CramCardList
        cards={cards}
        category={category}
        onCategoryChange={setCategory}
        sessionId={sessionId}
        onReload={loadCards}
        speak={speak}
        speaking={speaking}
        onStudy={studyCard}
      />
    </div>
    </CramActions.Provider>
  );
}

/* ============================ 分类筛选(来源) ============================ */

/** "all" = 不筛,全部一起复习。 */
type CatFilter = CramCategory | "all";

type CatStat = { total: number; due: number };

function categoryStats(cards: CramCard[]): Map<CatFilter, CatStat> {
  const m = new Map<CatFilter, CatStat>();
  const bump = (k: CatFilter, due: boolean) => {
    const s = m.get(k) ?? { total: 0, due: 0 };
    s.total += 1;
    if (due) s.due += 1;
    m.set(k, s);
  };
  for (const c of cards) {
    bump("all", c.isDue);
    bump(c.category, c.isDue);
  }
  return m;
}

/**
 * 按来源挑一类来复习。只列出真有卡的分类 —— 没导过题库就不该看见「题库导入」这个空标签。
 * 数字是「到期 / 总数」:一眼看出这一类今天还欠多少。
 */
function CategoryFilterBar({
  cards,
  value,
  onChange,
}: {
  cards: CramCard[];
  value: CatFilter;
  onChange: (v: CatFilter) => void;
}) {
  const stats = useMemo(() => categoryStats(cards), [cards]);
  // 当前选中的那一类**永远**留一枚芯片,哪怕它的卡刚被改分类/删光了 —— 否则筛选还生效着、
  // 切回「全部」的入口却没了,复习面板就卡在一个空分类上。
  const shown: CatFilter[] = ["all", ...CRAM_CATEGORIES.filter((c) => (stats.get(c)?.total ?? 0) > 0 || c === value)];
  if (shown.length <= 2 && value === "all") return null; // 只有一类且没在筛,筛选条纯属噪音

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-slate-400">按来源挑：</span>
      {shown.map((key) => {
        const s = stats.get(key) ?? { total: 0, due: 0 };
        const meta = key === "all" ? null : CRAM_CATEGORY_META[key];
        const active = value === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            title={meta ? `${meta.hint}（到期 ${s.due} / 共 ${s.total}）` : `所有来源一起复习（到期 ${s.due} / 共 ${s.total}）`}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
              active
                ? "border-emerald-600 bg-emerald-600 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
            }`}
          >
            {meta ? `${meta.icon} ${meta.label}` : "🗂 全部"}
            <span className={active ? "ml-1 text-emerald-100" : "ml-1 text-slate-400"}>
              {s.due}/{s.total}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 改一张卡的来源分类。历史卡片的分类是按形态推断出来的(❓标记 / 有没有题面 / 是不是同一秒批量写入),
 * 个别会归错 —— 这里给个改的地方,改完立刻按新分类归队。
 * 单词卡 / 记忆图卡的分类由卡片类型定死(渲染方式不一样),只显示不给改。
 */
function CategoryPicker({ card, onChanged }: { card: CramCard; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  // 下拉是受控的、值只来自服务端拉回来的 cards。不本地记一份的话,选完会先弹回旧分类,
  // 等整份卡表(几百张)重新拉回来才跳到新的 —— 中间那段和「压根没点上」看着一模一样。
  const [pending, setPending] = useState<CramBlockCategory | null>(null);
  useEffect(() => {
    if (pending && card.category === pending) setPending(null); // 刷新落地了,交回给服务端的值
  }, [card.category, pending]);

  if (card.kind !== "block") {
    return (
      <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
        来源分类
        <CategoryTag category={card.category} />
        <span>（按卡片类型定，不可改）</span>
      </p>
    );
  }

  const value = pending ?? card.category;

  async function change(next: string) {
    if (!isCramBlockCategory(next) || next === value) return;
    setPending(next);
    setSaving(true);
    setError(false);
    const r = await postJson("/api/job-hunter/interview/cram/card", { id: card.id, source: next }, "PUT");
    setSaving(false);
    if (r.ok) {
      onChanged();
    } else {
      setPending(null); // 没存上就别显示成已改
      setError(true);
    }
  }

  return (
    <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-400">
      来源分类
      <select
        value={value}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 disabled:opacity-60"
      >
        {CRAM_BLOCK_CATEGORIES.map((c: CramBlockCategory) => (
          <option key={c} value={c}>
            {CRAM_CATEGORY_META[c].icon} {CRAM_CATEGORY_META[c].label}
          </option>
        ))}
      </select>
      {saving && <span>保存中…</span>}
      {error && <span className="text-rose-500">改分类失败</span>}
    </p>
  );
}

/** 卡片上的分类小标签。 */
function CategoryTag({ category, className = "" }: { category: CramCategory; className?: string }) {
  const meta = CRAM_CATEGORY_META[category];
  return (
    <span title={meta.hint} className={`rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ${className}`}>
      {meta.icon} {meta.label}
    </span>
  );
}

/* ============================ 复习面板 ============================ */

function CramReview({
  sessionId,
  cards,
  onReload,
  speak,
  speaking,
  studyReq,
  category,
  onCategoryChange,
}: {
  sessionId: number;
  cards: CramCard[];
  onReload: () => void;
  speak: (t: string) => void;
  speaking: boolean;
  /** 清单里点「学习」发来的请求(seq 自增)。null = 没点过。 */
  studyReq: { id: number; seq: number } | null;
  /** 只复习这一类来源("all" = 全部)。和下面的卡片清单共用同一个筛选。 */
  category: CatFilter;
  onCategoryChange: (v: CatFilter) => void;
}) {
  const [queue, setQueue] = useState<CramCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const idxRef = useRef(0); // 给下面的插队用:setQueue 的函数式更新里读不到最新的 idx
  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);
  // 「第几轮」的号码牌:开一轮 / 换分类都 +1。自评是 async 的,回来时若号码变了说明这一轮
  // 已经被作废(换了分类、或又开了新一轮),再按当时的闭包去 setIdx 会把新队列的下标推乱。
  const roundRef = useRef(0);
  const queueLenRef = useRef(0);
  queueLenRef.current = queue.length;

  // 清单点「学习」:没在复习就单张开一轮;正在复习就插到当前这张后面(答完立刻轮到它)。
  // 依赖只看 seq —— cards 每次 loadCards 都换新数组,带进依赖会重复插队。
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  useEffect(() => {
    if (!studyReq) return;
    const card = cardsRef.current.find((c) => c.id === studyReq.id);
    if (!card) return;
    if (!queueLenRef.current) roundRef.current += 1; // 从空队列开的是新一轮(插队到已有队列里不算)
    setQueue((prev) => {
      if (!prev.length) {
        setIdx(0);
        setRevealed(false);
        setLastLabel(null);
        setMsg(null);
        return [card];
      }
      const pos = idxRef.current;
      if (prev[pos]?.id === card.id) return prev; // 正在看这张,不用插
      if (prev.slice(pos + 1).some((c) => c.id === card.id)) return prev; // 后面已经排着了
      setMsg("已插进队列，当前这张答完就轮到它。");
      const next = [...prev];
      next.splice(pos + 1, 0, card);
      return next;
    });
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [studyReq]);

  // 当前分类下的卡(上面的统计、下面的队列都只认这一批)。
  const visible = useMemo(
    () => (category === "all" ? cards : cards.filter((c) => c.category === category)),
    [cards, category],
  );

  const counts = useMemo(
    () => ({
      total: visible.length,
      due: visible.filter((c) => c.isDue).length,
      fresh: visible.filter((c) => c.state === "new").length,
      mastered: visible.filter((c) => c.state === "mastered").length,
    }),
    [visible],
  );

  // 换分类 = 换一批要背的东西:把没答完的这一轮收掉,重新开(每张的进度在自评时就已落库,不会丢)。
  const catRef = useRef(category);
  useEffect(() => {
    if (catRef.current === category) return; // 队列长度变化也会进来,不是换分类就什么都不做
    catRef.current = category;
    if (queue.length) setMsg("已切换分类，点下面重新开始这一类的复习。");
    roundRef.current += 1; // 作废这一轮:在飞的自评回来后别再去动新队列的下标
    readerRef.current?.pause(); // 卡片都撤了,别让面试官继续念上一题
    setQueue([]);
    setIdx(0);
    setRevealed(false);
  }, [category, queue.length]);

  /* ---- 面试官念题:换卡自动朗读题面(音频在服务端按文本缓存,同一题只合成一次) ---- */
  const [autoRead, setAutoRead] = useState(true);
  const [blocked, setBlocked] = useState(false); // 浏览器拦了自动播放(还没交互过)
  const readerRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    setAutoRead(localStorage.getItem(AUTO_READ_KEY) !== "0");
  }, []);
  useEffect(() => {
    const a = readerRef.current;
    return () => a?.pause();
  }, []);

  // queue 是开轮那一刻的快照(loadCards 不会重建它),所以按 id 回 cards 取最新的那一份 ——
  // 否则本轮中途改了这张卡的来源分类,卡上的分类标签还挂着旧的,和下面清单里自相矛盾。
  const snap = queue.length > 0 ? queue[idx] : null;
  const cur = useMemo(() => (snap ? (cards.find((c) => c.id === snap.id) ?? snap) : null), [snap, cards]);
  const curId = cur?.id ?? null;
  const curFront = cur?.front ?? "";
  const nextId = queue[idx + 1]?.id ?? null;

  const readCard = useCallback((id: number, front: string) => {
    // v 只是给浏览器缓存做版本号:卡片文字改了 → v 变 → 不会读到旧音。
    const url = `/api/job-hunter/interview/cram/speak?id=${id}&v=${textVersion(front)}`;
    let a = readerRef.current;
    if (!a) {
      a = new Audio();
      a.preload = "auto";
      readerRef.current = a;
    }
    a.pause();
    if (a.src !== location.origin + url) a.src = url;
    a.currentTime = 0;
    setBlocked(false);
    a.play().catch(() => setBlocked(true)); // 自动播放被拦:显示手动播放按钮
  }, []);

  // 换到新卡就念题(只念正面;svg 卡没有题面,跳过)。
  useEffect(() => {
    if (!autoRead || !curId || !curFront) return;
    readCard(curId, curFront);
  }, [autoRead, curId, curFront, readCard]);

  // 顺手把下一张的音频预热进浏览器缓存,轮到它时零等待。
  useEffect(() => {
    if (!autoRead || !nextId) return;
    const next = queue[idx + 1];
    if (!next?.front) return;
    const url = `/api/job-hunter/interview/cram/speak?id=${nextId}&v=${textVersion(next.front)}`;
    const t = setTimeout(() => void fetch(url).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [autoRead, nextId, idx, queue]);

  function start() {
    const q = visible.filter((c) => c.isDue);
    if (!q.length) {
      setMsg("今日没有到期的卡片 🎉");
      return;
    }
    roundRef.current += 1;
    setQueue(q);
    setIdx(0);
    setRevealed(false);
    setLastLabel(null);
    setMsg(null);
  }

  const needsReveal = cur ? (cur.kind === "word" ? true : cur.kind === "block" ? !!cur.front : false) : false;
  const showBack = revealed || !needsReveal;

  async function grade(g: "forgot" | "vague" | "clear") {
    if (!cur) return;
    setGrading(true);
    const round = roundRef.current;
    const label = cur.kind === "word" ? cur.front || cur.content : cur.front || cur.content.slice(0, 18) || "卡片";
    const r = await postJson<{ nextReviewLabel: string }>("/api/job-hunter/interview/cram/card/review", { id: cur.id, grade: g });
    // 这次自评在飞的时候换了分类 / 又开了新一轮:成绩已经落库了,但下面那些 idx 是上一轮的,
    // 照着推会把新队列翻到中间去(甚至把新一轮直接判成「本轮完成」)。到此为止。
    if (round !== roundRef.current) {
      setGrading(false);
      return;
    }
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
    <div ref={rootRef} className="rounded-2xl border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-emerald-900">🧠 遗忘曲线复习</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const next = !autoRead;
              setAutoRead(next);
              localStorage.setItem(AUTO_READ_KEY, next ? "1" : "0");
              if (!next) readerRef.current?.pause();
              else if (curId && curFront) readCard(curId, curFront);
            }}
            title="换卡时自动用面试官的声音念题(音频已缓存，不会重复调用 API)"
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              autoRead
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "border border-slate-200 text-slate-500 hover:border-emerald-300"
            }`}
          >
            {autoRead ? "🔊 自动念题" : "🔇 自动念题"}
          </button>
          <span className="text-xs text-slate-400">共 {cards.length} 张</span>
        </div>
      </div>

      <CategoryFilterBar cards={cards} value={category} onChange={onCategoryChange} />
      {category !== "all" && (
        <p className="mt-2 text-[11px] text-emerald-700">
          只复习「{CRAM_CATEGORY_META[category].icon} {CRAM_CATEGORY_META[category].label}」这一类（{counts.total} 张）；
          下面的卡片清单也只显示这一类。
        </p>
      )}

      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat label="今日到期" value={counts.due} tone="rose" />
        <Stat label="新卡" value={counts.fresh} tone="sky" />
        <Stat label="已掌握" value={counts.mastered} tone="emerald" />
        <Stat label={category === "all" ? "总数" : "本类总数"} value={counts.total} tone="slate" />
      </div>

      {msg && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      {cur ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              第 {idx + 1} / {queue.length} 张
              {cur.front && (
                <button
                  onClick={() => readCard(cur.id, cur.front)}
                  title="再念一遍题面"
                  className={`rounded-md border px-1.5 py-0.5 text-xs transition ${
                    blocked
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-700"
                  }`}
                >
                  🔊{blocked ? " 点这里念题" : ""}
                </button>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <CategoryTag category={cur.category} />
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[cur.state]}`}>
                {KIND_LABEL[cur.kind]} · {SR_STATE_LABEL[cur.state]}
              </span>
            </span>
          </div>
          <CramFlashcard key={cur.id} card={cur} showBack={showBack} sessionId={sessionId} speak={speak} speaking={speaking} onChanged={onReload} />
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
          {counts.due === 0
            ? category === "all"
              ? "今日无到期卡片 🎉"
              : `「${CRAM_CATEGORY_META[category].label}」今天没有到期的了 🎉`
            : category === "all"
              ? `开始复习（${counts.due} 张到期）`
              : `复习「${CRAM_CATEGORY_META[category].label}」（${counts.due} 张到期）`}
        </button>
      )}
    </div>
  );
}

/** 一张复习卡的展示 + 内联编辑(题库答案不准时改)。用 key={card.id} 挂载,换卡自动重置。 */
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
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState(card.front); // 正面(问题/词)
  const [ec, setEc] = useState(card.content); // 背面(答案/释义/说明)
  const [saving, setSaving] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineErr, setRefineErr] = useState<string | null>(null);
  const [justRefined, setJustRefined] = useState(false);
  const [refineNotes, setRefineNotes] = useState<string[]>([]);

  // 代码块点「追问」→ 把这段代码交给卡片底部的追问区(seq 变化 = 再点一次也重新聚焦输入框)。
  const [pendingAsk, setPendingAsk] = useState<{ snippet: string; ref: string; seq: number } | null>(null);
  const askSeq = useRef(0);
  const askCtx = useMemo(
    () => ({
      askAbout: (snippet: string, ref: string) => {
        askSeq.current += 1;
        setPendingAsk({ snippet, ref, seq: askSeq.current });
      },
    }),
    [],
  );

  async function save() {
    setSaving(true);
    const r = await postJson("/api/job-hunter/interview/cram/card", { id: card.id, front: ef, content: ec }, "PUT");
    setSaving(false);
    if (r.ok) {
      onChanged?.();
      setEditing(false);
      setJustRefined(false);
      setRefineNotes([]);
    }
  }

  // AI 校对+润色:改语法 + 事实核查纠错(不加内容),把结果填进编辑框、附「纠正/存疑」清单让用户确认后保存。
  async function aiRefine() {
    setRefining(true);
    setRefineErr(null);
    const r = await postJson<{ refined: string; notes?: string[] }>("/api/job-hunter/interview/cram/refine", {
      question: ef,
      answer: ec,
    });
    setRefining(false);
    if (r.ok && r.data) {
      setEc(r.data.refined);
      setRefineNotes(Array.isArray(r.data.notes) ? r.data.notes : []);
      setJustRefined(true);
      setEditing(true);
    } else {
      setRefineErr(r.error || "润色失败");
    }
  }

  const canRefine = card.kind !== "svg" && !!ec.trim();

  if (editing) {
    return (
      <div className="space-y-2">
        {justRefined && (
          <div className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
            <p className="font-medium">✨ 已 AI 校对 + 润色（改语法 + 纠正明显的事实/技术错误，未加内容）。检查后点「保存」，不满意点「取消」还原。</p>
            {refineNotes.length > 0 ? (
              <div className="mt-1.5">
                <p className="font-medium">🔍 纠正 / 存疑（请自行核对）：</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-violet-800">
                  {refineNotes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-1 text-violet-500">✓ 没发现明显的事实/技术错误</p>
            )}
          </div>
        )}
        {card.kind === "svg" && (
          <div className="overflow-x-auto rounded-lg border border-slate-100 bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={svgDataUri(card.svg)} alt="记忆卡片" className="mx-auto max-w-full" />
          </div>
        )}
        {card.kind !== "svg" && (
          <div>
            <label className="mb-0.5 block text-xs font-medium text-slate-500">{card.kind === "word" ? "词" : "正面 / 问题"}</label>
            <textarea
              value={ef}
              onChange={(e) => setEf(e.target.value)}
              rows={card.kind === "word" ? 1 : 2}
              className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
          </div>
        )}
        <div>
          <label className="mb-0.5 block text-xs font-medium text-slate-500">
            {card.kind === "svg" ? "图片说明" : card.kind === "word" ? "释义" : "背面 / 答案"}
          </label>
          <textarea
            value={ec}
            onChange={(e) => setEc(e.target.value)}
            rows={7}
            className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed outline-none focus:border-emerald-400"
          />
        </div>
        {refineErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{refineErr}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            onClick={() => {
              setEf(card.front);
              setEc(card.content);
              setEditing(false);
              setJustRefined(false);
              setRefineNotes([]);
              setRefineErr(null);
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
          >
            取消
          </button>
          {canRefine && (
            <button
              onClick={aiRefine}
              disabled={refining}
              title="AI 校对润色：改语法 + 核查并纠正明显的事实/技术错误（不加内容）"
              className="ml-auto rounded-lg border border-violet-200 px-3 py-1.5 text-xs font-medium text-violet-600 transition hover:bg-violet-50 disabled:opacity-60"
            >
              {refining ? "润色中…" : "✨ AI 润色"}
            </button>
          )}
        </div>
      </div>
    );
  }

  const editBtn = (
    <div className="mb-1 flex items-center justify-end gap-3">
      {refineErr && <span className="text-xs text-rose-500">{refineErr}</span>}
      {canRefine && (
        <button
          onClick={aiRefine}
          disabled={refining}
          title="AI 校对润色：改语法 + 核查并纠正明显的事实/技术错误（不加内容）"
          className="text-xs font-medium text-violet-400 transition hover:text-violet-600 disabled:opacity-60"
        >
          {refining ? "润色中…" : "✨ AI 润色"}
        </button>
      )}
      <button
        onClick={() => setEditing(true)}
        title="修改这张卡"
        className="text-xs text-slate-300 transition hover:text-slate-500"
      >
        ✏️ 改
      </button>
    </div>
  );

  if (card.kind === "word") {
    const en = card.extra?.en || ef;
    const ipa = card.extra?.ipa || "";
    // 释义以可编辑的 content(ec)为准,这样「改」/「AI 润色」后能立刻反映;退回 extra.zh。
    const zh = ec || card.extra?.zh || "";
    const note = card.extra?.note || "";
    return (
      <>
        {editBtn}
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-800">{ef}</span>
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
        {editBtn}
        <div className="overflow-x-auto rounded-lg border border-slate-100 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={svgDataUri(card.svg)} alt={ec || "记忆卡片"} className="mx-auto max-w-full" />
        </div>
        {ec && <CramSelectable sessionId={sessionId} text={ec} className="mt-1 text-xs text-slate-500" onChanged={onChanged} />}
      </>
    );
  }

  // block
  return (
    <CardAsk.Provider value={askCtx}>
      {editBtn}
      {ef && <div className="whitespace-pre-wrap text-base font-semibold text-slate-800">{ef}</div>}
      {/* 原答案本身也可能带 ```代码块```(追问存下来的卡常有),和简历版回答同一套渲染。 */}
      {showBack && ec && <AnswerBody sessionId={sessionId} text={ec} onChanged={onChanged} />}
      {showBack && (ec || ef) && (
        <ProjectAnswerSection card={card} sessionId={sessionId} onChanged={onChanged} />
      )}
      {showBack && (ec || ef) && (
        <FollowupThread
          cardId={card.id}
          sessionId={sessionId}
          initial={card.followups}
          pending={pendingAsk}
          onClearPending={() => setPendingAsk(null)}
          onChanged={onChanged}
        />
      )}
    </CardAsk.Provider>
  );
}

/* ============================ session 级设置(默认项目 / 代码库) ============================ */

/**
 * 简历标题下的一行内联设置。目前两处:
 *  - preferredProject:简历版回答默认讲哪个项目(答不上这道题时 AI 才换别的);
 *  - codePath:代码佐证从哪个本机代码库里取(空 = 回答里不带代码块)。
 * 都存在 session 上 —— 一份简历设一次,不用每张卡都选。路径合法性由后端校验后回填。
 */
function SessionTextSetting({
  sessionId,
  field,
  label,
  empty,
  placeholder,
  value,
  wide,
  onSaved,
}: {
  sessionId: number;
  field: "preferredProject" | "codePath";
  label: string;
  empty: string;
  placeholder: string;
  value: string;
  wide?: boolean;
  onSaved: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    const r = await postJson<{ preferredProject: string; codePath: string }>(
      "/api/job-hunter/interview/cram/session",
      { id: sessionId, [field]: draft },
      "PUT",
    );
    setSaving(false);
    if (r.ok && r.data) {
      onSaved(r.data[field]);
      setEditing(false);
    } else {
      setErr(r.error || "保存失败");
    }
  }

  if (!editing) {
    return (
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
        <span>{label}：</span>
        <span className={value ? "font-medium text-indigo-600" : "text-slate-400"} title={value || undefined}>
          {value || empty}
        </span>
        <button
          onClick={() => {
            setDraft(value);
            setErr(null);
            setEditing(true);
          }}
          className="text-slate-300 transition hover:text-slate-500"
        >
          改
        </button>
      </p>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        placeholder={placeholder}
        className={`${wide ? "w-96" : "w-64"} rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-indigo-400`}
      />
      <button
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
      >
        {saving ? "保存中…" : "保存"}
      </button>
      <button
        onClick={() => {
          setEditing(false);
          setErr(null);
        }}
        className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
      >
        取消
      </button>
      {err && <span className="text-xs text-rose-500">{err}</span>}
    </div>
  );
}

/* ============================ 结合我的项目(简历版回答) ============================ */

/**
 * 同一道题,再给一份「按这份简历里的项目」的第一人称回答,显示在原答案**下面**;
 * 原答案(content)一字不动,这份单独存 project_answer,可重生成 / 手改 / 删。
 *
 * 本地状态先行:复习队列里的 card 是开轮时的快照(onChanged 只刷新下面的卡片清单),
 * 生成完不会自己回流到这张卡,所以以 text 为准显示。
 */
function ProjectAnswerSection({
  card,
  sessionId,
  onChanged,
}: {
  card: CramCard;
  sessionId: number;
  onChanged: () => void;
}) {
  const [text, setText] = useState(card.projectAnswer || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const URL_ = "/api/job-hunter/interview/cram/project-answer";

  async function generate() {
    setBusy(true);
    setErr(null);
    const r = await postJson<{ projectAnswer: string }>(URL_, { cardId: card.id });
    setBusy(false);
    if (r.ok && r.data) {
      setText(r.data.projectAnswer);
      setEditing(false);
      onChanged();
    } else {
      setErr(r.error || "生成失败");
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    const r = await postJson<{ projectAnswer: string }>(URL_, { cardId: card.id, projectAnswer: draft }, "PUT");
    setBusy(false);
    if (r.ok && r.data) {
      setText(r.data.projectAnswer);
      setEditing(false);
      onChanged();
    } else {
      setErr(r.error || "保存失败");
    }
  }

  async function clear() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`${URL_}?id=${card.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      setText("");
      setEditing(false);
      onChanged();
    } else {
      setErr("删除失败");
    }
  }

  if (!text && !editing) {
    return (
      <div className="mt-3 border-t border-dashed border-slate-200 pt-2">
        <button
          onClick={generate}
          disabled={busy}
          title="同一道题，AI 按这份简历里的项目再写一份第一人称回答，存下来（原答案不动）"
          className="rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60"
        >
          {busy ? "按简历生成中…" : "🧩 结合我的项目回答"}
        </button>
        {err && <span className="ml-2 text-xs text-rose-500">{err}</span>}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-indigo-700">🧩 结合我的项目（简历版回答）</p>
        <div className="flex items-center gap-2.5">
          {!editing && (
            <>
              <button
                onClick={generate}
                disabled={busy}
                title="按简历重新生成（覆盖这份）"
                className="text-xs font-medium text-indigo-500 transition hover:text-indigo-700 disabled:opacity-60"
              >
                {busy ? "生成中…" : "🔄 重新生成"}
              </button>
              <button
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
                className="text-xs text-slate-400 transition hover:text-slate-600"
              >
                ✏️ 改
              </button>
              <button
                onClick={clear}
                disabled={busy}
                className="text-xs text-slate-300 transition hover:text-rose-500 disabled:opacity-60"
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
            className="w-full resize-y rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-indigo-400"
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <AnswerBody sessionId={sessionId} text={text} onChanged={onChanged} />
      )}
      {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{err}</p>}
    </div>
  );
}

/**
 * 简历版回答的正文:散文段可划词(翻译/加卡/追问),```围栏```的代码佐证按代码块渲染
 * (等宽、深色、可横向滚动、可一键复制)。代码块不裹划词——在代码里选中一片会疯狂弹翻译浮层。
 */
function AnswerBody({
  sessionId,
  text,
  onChanged,
}: {
  sessionId: number;
  text: string;
  onChanged: () => void;
}) {
  const blocks = useMemo(() => splitFencedBlocks(text), [text]);
  // 代码块上面那行常常就是文件路径(模型按提示词写的),拿来当追问时的「针对哪段代码」标签。
  const pathAbove = (i: number): string => {
    const prev = blocks[i - 1];
    if (!prev || prev.kind !== "text") return "";
    const last = prev.body.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
    return /^[\w./@-]+\/[\w./@-]+\.\w{1,5}$/.test(last) ? last : "";
  };
  return (
    <div className="mt-1.5 space-y-2">
      {blocks.map((b, i) =>
        b.kind === "code" ? (
          <CodeEvidence key={i} lang={b.lang} code={b.body} path={pathAbove(i)} />
        ) : (
          <CramSelectable
            key={i}
            sessionId={sessionId}
            text={b.body}
            className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700"
            onChanged={onChanged}
          />
        ),
      )}
    </div>
  );
}

function CodeEvidence({ lang, code, path }: { lang: string; code: string; path?: string }) {
  const [copied, setCopied] = useState(false);
  const { askAbout } = useContext(CardAsk);
  return (
    <div className="group relative overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{lang || "code"}</span>
        <div className="flex items-center gap-3">
          {askAbout && (
            <button
              onClick={() => askAbout(code, path || lang || "这段代码")}
              title="就这段代码问一句，问答会留在这张卡里"
              className="text-[10px] text-sky-400 transition hover:text-sky-300"
            >
              💬 追问这段
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(code).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => undefined,
              );
            }}
            className="text-[10px] text-slate-500 transition hover:text-slate-200"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ============================ 就地追问(问答留在这张卡里) ============================ */

/**
 * 卡片底部的追问区:问一句(可针对上面某段代码),回答就留在**这张卡**上跟着复习 ——
 * 不新起卡片、不弹独立面板(那是阅读区 AskPanel 干的事)。
 * 已有的问答从 card.followups 来,新问的以接口返回的整份列表为准(本地 state 先行,
 * 因为复习队列里的 card 是开轮快照,不会自己回流)。
 */
function FollowupThread({
  cardId,
  sessionId,
  initial,
  pending,
  onClearPending,
  onChanged,
}: {
  cardId: number;
  sessionId: number;
  initial: Followup[];
  pending: { snippet: string; ref: string; seq: number } | null;
  onClearPending: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Followup[]>(initial || []);
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 点了某段代码的「追问这段」→ 展开输入框并聚焦(同一段再点一次也重新聚焦)。
  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const question = q.trim();
    if (!question || asking) return;
    setAsking(true);
    setErr(null);
    const r = await postJson<{ items: Followup[] }>("/api/job-hunter/interview/cram/card-followup", {
      cardId,
      question,
      snippet: pending?.snippet || "",
      ref: pending?.ref || "",
    });
    setAsking(false);
    if (r.ok && r.data) {
      setItems(r.data.items);
      setQ("");
      onClearPending();
      onChanged();
    } else {
      setErr(r.error || "追问失败");
    }
  }

  async function remove(id: number) {
    const res = await fetch(`/api/job-hunter/interview/cram/card-followup?cardId=${cardId}&id=${id}`, {
      method: "DELETE",
    });
    const j = await res.json().catch(() => null);
    if (j?.success) {
      setItems(j.items as Followup[]);
      onChanged();
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
      <p className="text-xs font-semibold text-sky-700">💬 追问（问答留在这张卡里，复习时一起看）</p>

      {items.length > 0 && (
        <div className="mt-2 space-y-2">
          {items.map((f) => (
            <div key={f.id} className="rounded-lg border border-sky-100 bg-white p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-slate-700">
                  ❓ {f.q}
                  {f.ref && <span className="ml-1.5 font-normal text-slate-400">· {f.ref}</span>}
                </p>
                <button
                  onClick={() => remove(f.id)}
                  title="删掉这条追问"
                  className="shrink-0 text-xs text-slate-300 transition hover:text-rose-500"
                >
                  ✕
                </button>
              </div>
              <AnswerBody sessionId={sessionId} text={f.a} onChanged={onChanged} />
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-200 bg-white px-2 py-1.5">
          <span className="shrink-0 text-[11px] font-medium text-sky-600">针对 {pending.ref}：</span>
          <code className="min-w-0 flex-1 truncate text-[11px] text-slate-500">
            {pending.snippet.split("\n").find((l) => l.trim()) || ""}
          </code>
          <button onClick={onClearPending} className="shrink-0 text-[11px] text-slate-300 hover:text-slate-500">
            ✕
          </button>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit();
          }}
          placeholder={pending ? "比如：这个 super 是什么意思？" : "对这张卡有什么想问的？（可先点代码块上的「追问这段」）"}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-sky-400"
        />
        <button
          onClick={submit}
          disabled={asking || !q.trim()}
          className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
        >
          {asking ? "思考中…" : "问"}
        </button>
      </div>
      {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{err}</p>}
    </div>
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
    // front 同时记下「选中的原文」+「问题」,复习时先看原文和自己的疑问,再揭示答案。
    const passage = ask.passage.trim();
    const front = passage ? `${passage}\n\n❓ ${askedQ}` : askedQ;
    const r = await postJson<{ id: number }>("/api/job-hunter/interview/cram/card", {
      sessionId,
      kind: "block",
      source: "ask", // 自己追问追出来的,复习时能单独挑这一类
      front,
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
          {/* 回答也支持划词:选词翻译 + 加单词卡/知识块 */}
          <CramSelectable
            sessionId={sessionId}
            text={answer}
            className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700"
            onChanged={onSaved}
          />
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

function CramCardList({
  cards,
  category,
  onCategoryChange,
  sessionId,
  onReload,
  speak,
  speaking,
  onStudy,
}: {
  cards: CramCard[];
  /** 和复习面板共用的来源筛选("all" = 全部)。 */
  category: CatFilter;
  onCategoryChange: (v: CatFilter) => void;
  sessionId: number;
  onReload: () => void;
  speak: (t: string) => void;
  speaking: boolean;
  onStudy: (card: CramCard) => void;
}) {
  const shown = category === "all" ? cards : cards.filter((c) => c.category === category);
  if (!cards.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
        还没有卡片。去上面的阅读区划词、加入知识块，或选一整段生成记忆卡片吧。
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">
          {category === "all"
            ? `全部卡片（${cards.length}）`
            : `${CRAM_CATEGORY_META[category].icon} ${CRAM_CATEGORY_META[category].label}（${shown.length} / ${cards.length}）`}
        </p>
        {category !== "all" && (
          <button onClick={() => onCategoryChange("all")} className="text-xs text-emerald-600 hover:underline">
            显示全部
          </button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-slate-400">
        点任意一张展开看全文（可划词翻译 / 加词 / 加知识块 / 改来源分类）；点「学习」把它插进上面的复习队列，答完就进遗忘曲线。
      </p>
      {!shown.length && (
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
          这一类下面还没有卡片。点上面的「🗂 全部」看所有卡。
        </p>
      )}
      <div className="mt-3 space-y-1.5">
        {shown.map((c) => (
          <CramCardRow
            key={c.id}
            card={c}
            sessionId={sessionId}
            onReload={onReload}
            speak={speak}
            speaking={speaking}
            onStudy={onStudy}
          />
        ))}
      </div>
    </div>
  );
}

function CramCardRow({
  card,
  sessionId,
  onReload,
  speak,
  speaking,
  onStudy,
}: {
  card: CramCard;
  sessionId: number;
  onReload: () => void;
  speak: (t: string) => void;
  speaking: boolean;
  onStudy: (card: CramCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  async function remove() {
    await fetch(`/api/job-hunter/interview/cram/card?id=${card.id}`, { method: "DELETE" });
    onReload();
  }
  const meta = CRAM_CATEGORY_META[card.category];
  const icon = meta.icon;
  // 一行预览:把 ``` 围栏标记去掉(带代码块的卡不然预览开头是一串 ```java)。
  const label = (card.front || card.content || (card.kind === "svg" ? "（图示）" : "")).replace(/```[\w+#.-]*\n?/g, "");
  return (
    <div className="rounded-lg border border-slate-100">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? "收起" : "展开看全文"}
        >
          <span title={`${meta.label}：${meta.hint}`} className="shrink-0 text-xs text-slate-400">
            {icon}
          </span>
          <span className="truncate text-sm text-slate-700">{label}</span>
          <span className="shrink-0 text-[10px] text-slate-300">{expanded ? "▲" : "▼"}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[card.state]}`}>
            {SR_STATE_LABEL[card.state]}
          </span>
          <button
            onClick={() => onStudy(card)}
            title="插进上面的复习队列，自评后按遗忘曲线排下次"
            className={`rounded-md px-2 py-0.5 text-xs font-medium transition ${
              card.state === "new"
                ? "bg-sky-600 text-white hover:bg-sky-700"
                : "border border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-600"
            }`}
          >
            {card.state === "new" ? "学习" : "复习"}
          </button>
          <button onClick={remove} className="text-xs text-slate-400 hover:text-rose-500">
            删除
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-3 py-3">
          <CategoryPicker card={card} onChanged={onReload} />
          <CramFlashcard key={card.id} card={card} showBack sessionId={sessionId} speak={speak} speaking={speaking} onChanged={onReload} />
        </div>
      )}
    </div>
  );
}

/* ============================ 追加复习资料(并进同一份阅读区) ============================ */

function AddMaterial({
  sessionId,
  currentHtml,
  onUpdated,
}: {
  sessionId: number;
  currentHtml: string;
  onUpdated: (mergedHtml: string) => void;
}) {
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileHtml, setFileHtml] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File | null) {
    setError(null);
    setFileHtml(null);
    if (!file) {
      setFileName("");
      return;
    }
    setPasted("");
    setFileName(file.name);
    if (!isDocx(file) && !isHtml(file)) {
      setError("请上传 .docx 或 .html 文件。");
      return;
    }
    setConverting(true);
    try {
      setFileHtml(await fileToHtml(file));
    } catch {
      setError("转换失败，请换一份文件再试。");
    } finally {
      setConverting(false);
    }
  }

  function onPaste(v: string) {
    setPasted(v);
    setError(null);
    if (v.trim()) {
      setFileHtml(null);
      setFileName("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const canSave = !!fileHtml || pasted.trim().length > 0;

  async function save() {
    const newHtml = fileHtml ?? (pasted.trim() ? textToHtml(pasted) : null);
    if (!newHtml) return;
    setSaving(true);
    setError(null);
    const label = fileName || "粘贴的复习资料";
    const merged = appendDoc(currentHtml, newHtml, label);
    const r = await postJson("/api/job-hunter/interview/cram/session", { id: sessionId, resumeHtml: merged }, "PUT");
    if (r.ok) {
      onUpdated(merged);
    } else {
      setError(r.error || "追加失败");
      setSaving(false);
    }
  }

  return (
    <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
      <p className="mb-2 text-xs font-medium text-emerald-700">把新的复习资料并进这份阅读区（粘贴或上传，二选一）</p>
      <textarea
        value={pasted}
        onChange={(e) => onPaste(e.target.value)}
        rows={4}
        placeholder="粘贴要追加的文本……"
        className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed outline-none focus:border-emerald-400"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-emerald-300">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          📄 {fileName ? fileName : "选文件"}
        </label>
        {converting && <span className="text-xs text-slate-400">读取中…</span>}
        <button
          onClick={save}
          disabled={!canSave || saving}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
        >
          {saving ? "追加中…" : "追加进阅读区"}
        </button>
      </div>
      {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

/* ============================ 导入面试题库 Excel(问题→问答闪卡) ============================ */

type ImportRow = { question: string; answer: string; major: string; category: string; stars: number };

function ImportExcel({
  sessionId,
  existingKeys,
  onImported,
}: {
  sessionId: number;
  /** 这份简历里已有的问答卡去重键,用来预告「这批里有几道会被跳过」。 */
  existingKeys: Set<string>;
  onImported: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selMajors, setSelMajors] = useState<Set<string>>(new Set());
  const [starMin, setStarMin] = useState(0);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ count: number; skipped: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File | null) {
    setError(null);
    setRows(null);
    if (!file) {
      setFileName("");
      return;
    }
    setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("请上传 .xlsx 文件（题库表格）。");
      return;
    }
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/job-hunter/interview/cram/xlsx", { method: "POST", body: fd });
      const j = await res.json().catch(() => null);
      if (j?.success) {
        const rs = j.rows as ImportRow[];
        setRows(rs);
        setSelMajors(new Set(rs.map((r) => r.major || "未分类")));
        setStarMin(0);
        setResult(null);
      } else {
        setError(j?.error || "解析失败");
      }
    } catch {
      setError("上传/解析失败");
    } finally {
      setParsing(false);
    }
  }

  const majors = useMemo(() => {
    const m = new Map<string, number>();
    (rows || []).forEach((r) => {
      const k = r.major || "未分类";
      m.set(k, (m.get(k) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = (rows || []).filter(
    (r) => selMajors.has(r.major || "未分类") && r.stars >= starMin && (r.question || r.answer),
  );

  // 预检:选中的这批里,有几道问题文本已经在卡片库里了(服务端会用同一套 frontKey 跳过)。
  const dupCount = useMemo(() => {
    const seen = new Set<string>();
    let n = 0;
    for (const r of filtered) {
      const k = frontKey(r.question);
      if (!k) continue;
      if (existingKeys.has(k) || seen.has(k)) n++;
      else seen.add(k);
    }
    return n;
  }, [filtered, existingKeys]);
  const freshCount = filtered.length - dupCount;

  async function doImport() {
    if (!filtered.length) return;
    setImporting(true);
    setError(null);
    setResult(null);
    const items = filtered.map((r) => ({ front: r.question, content: r.answer }));
    const r = await postJson<{ count: number; skipped: number }>("/api/job-hunter/interview/cram/import", {
      sessionId,
      items,
    });
    setImporting(false);
    if (r.ok && r.data) {
      setResult({ count: r.data.count, skipped: r.data.skipped ?? 0 });
      onImported();
    } else {
      setError(r.error || "导入失败");
    }
  }

  function toggleMajor(m: string) {
    setSelMajors((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  return (
    <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
      <p className="mb-2 text-xs font-medium text-sky-700">
        导入面试题库 Excel（.xlsx）→ 每道题变成一张「问题 / 答案」闪卡，进遗忘曲线，答案可划词翻译 / 追问 / 加词。
        <span className="ml-1 font-normal text-sky-600/80">已经导过的题会自动跳过，同一份表可以放心反复导。</span>
      </p>
      <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-sky-300">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        📊 {fileName ? fileName : "选择题库 Excel"}
      </label>
      {parsing && <p className="mt-2 text-xs text-slate-400">正在解析题库……</p>}
      {error && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}

      {rows && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-500">
            共解析到 <span className="font-semibold text-slate-700">{rows.length}</span> 道题。选要导入的大类 / 最低星级：
          </p>
          <div className="flex flex-wrap gap-1.5">
            {majors.map(([m, n]) => {
              const active = selMajors.has(m);
              return (
                <button
                  key={m}
                  onClick={() => toggleMajor(m)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    active ? "bg-sky-600 text-white" : "border border-slate-200 text-slate-500 hover:border-sky-300"
                  }`}
                >
                  {m} · {n}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">最低星级：</span>
            {[0, 1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                onClick={() => setStarMin(s)}
                className={`rounded-md px-2 py-0.5 text-xs font-medium transition ${
                  starMin === s ? "bg-amber-500 text-white" : "border border-slate-200 text-slate-500 hover:border-amber-300"
                }`}
              >
                {s === 0 ? "全部" : `${s}★+`}
              </button>
            ))}
          </div>
          {dupCount > 0 && (
            <p className="text-xs text-amber-600">
              选中的 {filtered.length} 道里，有 <span className="font-semibold">{dupCount}</span> 道已经在卡片库里了，
              导入时会自动跳过（不会变成两张、也不会丢掉已复习的进度）。
            </p>
          )}
          <button
            onClick={doImport}
            disabled={importing || !freshCount}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
          >
            {importing
              ? "导入中…"
              : !filtered.length
                ? "没有选中的题目"
                : !freshCount
                  ? "这批题都已经导过了"
                  : dupCount > 0
                    ? `导入 ${freshCount} 道新题（跳过 ${dupCount} 道已有）`
                    : `导入选中的 ${freshCount} 道题`}
          </button>
          {result && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              已导入 <span className="font-semibold">{result.count}</span> 道新题
              {result.skipped > 0 ? `，跳过 ${result.skipped} 道重复的。` : "。"}
            </p>
          )}
        </div>
      )}
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
}: {
  sessionId: number;
  text?: string;
  children?: ReactNode;
  className?: string;
  onChanged?: () => void;
}) {
  const { onAsk, onGenerate } = useContext(CramActions);
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
      source: "note", // 阅读区划一段直接加进来的要点
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
              {onGenerate && pop.term.trim().length >= 12 && (
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
