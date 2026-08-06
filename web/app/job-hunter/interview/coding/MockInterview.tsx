"use client";

import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { applyEditorKey } from "@/lib/job-hunter/interview/freeEditor";
import {
  PROBE_INTERVALS,
  codeIsEmpty,
  elapsedSec,
  formatDuration,
  isProbeInterval,
  shouldAutoAsk,
  type ProbeInterval,
} from "@/lib/job-hunter/interview/mockInterview";
import type { MockReview } from "@/lib/job-hunter/interview/schema";

/**
 * 「面试模式」:AI 现出一道 LeetCode 式算法题 → 你在空白编辑器里自由手写 →
 * 写的过程中面试官随时插话追问(问题会被念出来)→ 交卷后 AI 复盘。
 *
 * 和同目录的跟打训练是两种练法:那边练手感(照着标准答案敲),这边练「被问住的时候怎么答」。
 */

/* ============================ 类型 / 常量 ============================ */

type MockProblem = {
  id: number;
  title: string;
  titleZh: string;
  difficulty: number;
  lang: string;
  promptZh: string;
  promptEn: string;
  starterCode: string;
  topics: string[];
  /** 面试官开场念的那段(英文题干 + 第一个示例) */
  speech: string;
};

/** 客户端的一轮追问。`answered` 只在前端用:区分「跳过了」和「还挂着没答」。 */
type Turn = {
  question: string;
  zh: string;
  kind: string;
  answer: string;
  answered: boolean;
  askedAt: number;
};

type Session = {
  id: number;
  problemId: number | null;
  title: string;
  lang: string;
  code: string;
  turns: Turn[];
  review: MockReview | null;
  verdict: string;
  durationSec: number;
  createdAt: string;
};

const KIND_LABEL: Record<string, string> = {
  approach: "思路",
  complexity: "复杂度",
  "edge-case": "边界",
  tradeoff: "取舍",
  followup: "延伸",
  "code-detail": "代码细节",
  test: "测试",
};

const VERDICT_META: Record<string, { label: string; cls: string }> = {
  strong: { label: "这轮能过", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  ok: { label: "勉强，追问会掉分", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  weak: { label: "过不了", cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

const DIFF_LABEL: Record<string, string> = { easy: "简单", medium: "中等", hard: "偏难" };
const LANG_LABEL: Record<string, string> = { java: "Java", javascript: "JavaScript" };

const INTERVAL_KEY = "coding:mockInterval";
const LANG_KEY = "coding:mockLang";

const INTERVAL_LABEL: Record<number, string> = {
  0: "不自动问",
  30: "每 30 秒",
  60: "每 1 分钟",
  120: "每 2 分钟",
};

/* ============================ 组件 ============================ */

export default function MockInterview() {
  const [phase, setPhase] = useState<"setup" | "live" | "done">("setup");
  const [problem, setProblem] = useState<MockProblem | null>(null);
  const [code, setCode] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [probing, setProbing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [waited, setWaited] = useState(0); // 出题等了几秒(慢的时候别让按钮看着像卡死)
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [, setTick] = useState(0);

  // 出题参数
  const [lang, setLang] = useState("java");
  const [difficulty, setDifficulty] = useState("medium");
  const [topics, setTopics] = useState("");
  const [interval, setIntervalSec] = useState<ProbeInterval>(60);

  // 交卷 / 复盘
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState<MockReview | null>(null);
  const [solution, setSolution] = useState("");
  const [showSolution, setShowSolution] = useState(false);

  const [history, setHistory] = useState<Session[] | null>(null);
  const [openSession, setOpenSession] = useState<number | null>(null);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAskedAtRef = useRef(0);
  const codeLenAtLastAskRef = useRef(0);

  useEffect(() => {
    // 注意别写成 Number(localStorage.getItem(...)):没存过时 Number(null) = 0,
    // 而 0 正好是合法档位「不自动问」—— 一进来就把自动追问给关了。
    const savedInterval = localStorage.getItem(INTERVAL_KEY);
    if (savedInterval !== null && isProbeInterval(Number(savedInterval))) {
      setIntervalSec(Number(savedInterval) as ProbeInterval);
    }
    const savedLang = localStorage.getItem(LANG_KEY);
    if (savedLang === "java" || savedLang === "javascript") setLang(savedLang);
  }, []);

  /* ---------------- 念题 / 念问题 ---------------- */

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [ttsBlocked, setTtsBlocked] = useState(false);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    try {
      setSpeaking(true);
      const res = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const prev = audioRef.current;
      if (prev) {
        prev.pause();
        if (prev.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
      }
      const a = new Audio();
      a.preload = "auto";
      a.src = URL.createObjectURL(blob);
      audioRef.current = a;
      a.addEventListener("ended", () => setSpeaking(false), { once: true });
      // 自动播放可能被浏览器拦(还没交互过);拦了就露一个手动播放的按钮出来。
      a.play().then(
        () => setTtsBlocked(false),
        () => {
          setTtsBlocked(true);
          setSpeaking(false);
        },
      );
    } catch {
      setSpeaking(false);
    }
  }, []);

  useEffect(
    () => () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        if (a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
      }
    },
    [],
  );

  /* ---------------- 追问 ---------------- */

  const pending = turns.length > 0 && !turns[turns.length - 1].answered;

  // 计时器要读最新状态,但又不能每次 setState 都重建 —— 用一个 ref 装当前快照。
  const snapRef = useRef({ code, turns, probing, interval, pending, problemId: 0, startedAt });
  snapRef.current = { code, turns, probing, interval, pending, problemId: problem?.id ?? 0, startedAt };

  const probe = useCallback(async () => {
    const s = snapRef.current;
    if (!s.problemId || s.probing) return;
    setProbing(true);
    lastAskedAtRef.current = Date.now(); // 先占住时间,免得请求慢的时候计时器又发一次
    codeLenAtLastAskRef.current = s.code.length;
    try {
      const res = await fetch("/api/job-hunter/interview/coding/mock/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problemId: s.problemId,
          code: s.code,
          elapsedSec: elapsedSec(s.startedAt, Date.now()),
          turns: s.turns.map((t) => ({ question: t.question, zh: t.zh, kind: t.kind, answer: t.answer })),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) {
        setError(j?.error || "追问失败，等下再试或点「再问我一个」。");
        return;
      }
      const p = j.probe as { question: string; zh: string; kind: string };
      setError("");
      setTurns((prev) => [...prev, { ...p, answer: "", answered: false, askedAt: Date.now() }]);
      void speak(p.question);
    } catch {
      setError("网络异常，这一问没发出去。");
    } finally {
      setProbing(false);
    }
  }, [speak]);

  const probeRef = useRef(probe);
  probeRef.current = probe;

  // 一秒一跳:驱动计时显示,顺便判断该不该冒出下一个追问。
  useEffect(() => {
    if (phase !== "live") return;
    const t = window.setInterval(() => {
      setTick((n) => n + 1);
      const s = snapRef.current;
      const due = shouldAutoAsk({
        enabled: true,
        intervalSec: s.interval,
        now: Date.now(),
        lastAskedAt: lastAskedAtRef.current,
        pending: s.pending,
        busy: s.probing,
        codeLen: s.code.length,
        codeLenAtLastAsk: codeLenAtLastAskRef.current,
      });
      if (due) void probeRef.current();
    }, 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  /* ---------------- 语音作答(录音 → 转写 → 填进答题框) ---------------- */

  const [canRecord, setCanRecord] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setCanRecord(
      typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined",
    );
  }, []);

  useEffect(
    () => () => {
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "answer.webm");
          const res = await fetch("/api/job-hunter/interview/transcribe", { method: "POST", body: fd });
          const j = await res.json().catch(() => null);
          if (j?.success && j.text) {
            const prev = draftRef.current.trim();
            setDraft(prev ? `${prev} ${j.text}` : j.text);
          } else {
            setError(j?.error || "转写失败，直接打字答吧。");
          }
        } catch {
          setError("网络异常，转写失败。");
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch {
      setError("无法访问麦克风（需要允许麦克风权限）。");
    }
  }

  function stopRec() {
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    setRecording(false);
  }

  /* ---------------- 流程 ---------------- */

  /** from: "ai" = 现出一道(慢);"bank" = 从题库挑一道(即时)。 */
  async function start(from: "ai" | "bank" = "ai") {
    setStarting(true);
    setError("");
    const t0 = Date.now();
    const tick = window.setInterval(() => setWaited(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const res =
        from === "bank"
          ? await fetch("/api/job-hunter/interview/coding/mock/problem")
          : await fetch("/api/job-hunter/interview/coding/mock/problem", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lang, difficulty, topics }),
            });
      const j = await res.json().catch(() => null);
      if (!j?.success) {
        throw new Error(
          from === "ai"
            ? `${j?.error || "出题失败"}（AI 有时会卡住，可以点下面「从题库挑一道」直接开始）`
            : j?.error || "题库里没挑到题",
        );
      }
      const p = j.problem as MockProblem;
      const now = Date.now();
      setProblem(p);
      setCode(p.starterCode);
      setTurns([]);
      setDraft("");
      setReview(null);
      setSolution("");
      setShowSolution(false);
      setStartedAt(now);
      lastAskedAtRef.current = now; // 第一问等一个间隔再来,先让人把题读完
      codeLenAtLastAskRef.current = p.starterCode.length;
      setPhase("live");
      void speak(p.speech); // 面试官先把题念一遍
      setTimeout(() => areaRef.current?.focus(), 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : "出题失败");
    } finally {
      window.clearInterval(tick);
      setWaited(0);
      setStarting(false);
    }
  }

  /** 答完/跳过这一问:重新起算下一问的间隔,让人先回去写一会儿代码,别一答完就又被问。 */
  function closeTurn(answer: string) {
    setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, answer, answered: true } : t)));
    lastAskedAtRef.current = Date.now();
    codeLenAtLastAskRef.current = code.length;
    setDraft("");
    areaRef.current?.focus();
  }

  async function finish() {
    if (!problem) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/job-hunter/interview/coding/mock/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problemId: problem.id,
          code,
          elapsedSec: elapsedSec(startedAt, Date.now()),
          turns: turns.map((t) => ({ question: t.question, zh: t.zh, kind: t.kind, answer: t.answer })),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error || "复盘失败");
      setReview(j.review as MockReview);
      setSolution(typeof j.solution === "string" ? j.solution : "");
      setPhase("done");
      audioRef.current?.pause();
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "复盘失败");
    } finally {
      setSubmitting(false);
    }
  }

  const loadHistory = useCallback(() => {
    fetch("/api/job-hunter/interview/coding/mock/sessions")
      .then((r) => r.json())
      .then((j) => setHistory(j?.success ? (j.items as Session[]) : []))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (phase === "setup") loadHistory();
  }, [phase, loadHistory]);

  async function removeSession(id: number) {
    await fetch(`/api/job-hunter/interview/coding/mock/sessions?id=${id}`, { method: "DELETE" });
    loadHistory();
  }

  /* ---------------- 编辑器按键 ---------------- */

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+A / Cmd+Z 之类照常
    const el = e.currentTarget;
    const out = applyEditorKey(el.value, el.selectionStart, el.selectionEnd, e.key, { shift: e.shiftKey });
    if (!out) return;
    e.preventDefault();
    // 受控 textarea 摆光标必须等新值真的进了 DOM。用 flushSync 同步刷,别用 requestAnimationFrame ——
    // 页面在后台标签页时 rAF 根本不触发,光标就会被留在文本末尾(本仓库踩过这个节流的坑)。
    flushSync(() => setCode(out.value));
    el.setSelectionRange(out.cursor, out.cursor);
  }

  function onCodeChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setCode(e.target.value);
  }

  /* ============================ 渲染 ============================ */

  const seconds = phase === "live" ? elapsedSec(startedAt, Date.now()) : 0;
  const last = turns.length ? turns[turns.length - 1] : null;

  if (phase === "setup") {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 shadow-sm">
          <p className="text-sm font-semibold text-indigo-900">🎤 面试模式：AI 出题 → 你手写 → 边写边被追问</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            出一道 LeetCode 式算法题（英文题面，和真面试一样），你在空白编辑器里自己写。
            写的过程中面试官会随时插话追问——问题会用面试官的声音念出来，你可以打字答，也可以直接说。
            交卷后 AI 复盘：代码对不对、复杂度、每个追问答得怎么样，再给一份英文口述范本。
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-500">
              语言
              <select
                value={lang}
                onChange={(e) => {
                  setLang(e.target.value);
                  localStorage.setItem(LANG_KEY, e.target.value);
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
              >
                <option value="java">Java</option>
                <option value="javascript">JavaScript</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">
              难度
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
              >
                <option value="easy">简单</option>
                <option value="medium">中等</option>
                <option value="hard">偏难</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">
              追问频率
              <select
                value={interval}
                onChange={(e) => {
                  const v = Number(e.target.value) as ProbeInterval;
                  setIntervalSec(v);
                  localStorage.setItem(INTERVAL_KEY, String(v));
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
              >
                {PROBE_INTERVALS.map((v) => (
                  <option key={v} value={v}>
                    {INTERVAL_LABEL[v]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 block text-xs text-slate-500">
            想练的方向（可留空）
            <input
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="例：滑动窗口 / 二叉树 / 堆 / 区间合并"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 placeholder:text-slate-300"
            />
          </label>

          {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>}

          <button
            onClick={() => void start("ai")}
            disabled={starting}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
          >
            {starting ? `面试官正在出题……${waited > 0 ? ` ${waited}s` : ""}` : "开始面试 →"}
          </button>
          <button
            onClick={() => void start("bank")}
            disabled={starting}
            className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-5 py-2 text-xs font-medium text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-60"
          >
            不等 AI，从题库挑一道算法题
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            出的题会同时进算法题库，面完还能拿去跟打。
          </p>
        </div>

        <HistoryList
          history={history}
          openId={openSession}
          onToggle={(id) => setOpenSession((cur) => (cur === id ? null : id))}
          onDelete={removeSession}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 题面 */}
      {problem && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-semibold text-slate-900">{problem.title}</p>
              <p className="text-xs text-slate-400">
                {problem.titleZh} · {DIFF_LABEL[["", "easy", "medium", "hard"][problem.difficulty] ?? "medium"] ?? "中等"} ·{" "}
                {LANG_LABEL[problem.lang] ?? problem.lang}
                {problem.topics.length > 0 && ` · ${problem.topics.join(" / ")}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600">
                ⏱ {formatDuration(seconds)}
              </span>
              <button
                onClick={() => void speak(problem.speech)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
              >
                {speaking ? "🔊 念着呢" : "🔊 再念一遍题"}
              </button>
            </div>
          </div>

          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
            {problem.promptEn}
          </pre>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600">看中文题面</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
              {problem.promptZh}
            </pre>
          </details>
        </div>
      )}

      {error && <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>}

      {/* 面试官追问 */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-amber-900">
            🎙 面试官{turns.length > 0 && <span className="ml-1 text-xs font-normal text-amber-700">已问 {turns.length} 个</span>}
          </p>
          <div className="flex items-center gap-2">
            <select
              value={interval}
              onChange={(e) => {
                const v = Number(e.target.value) as ProbeInterval;
                setIntervalSec(v);
                localStorage.setItem(INTERVAL_KEY, String(v));
              }}
              className="rounded-lg border border-amber-200 bg-white px-2 py-1 text-[11px] text-slate-600"
            >
              {PROBE_INTERVALS.map((v) => (
                <option key={v} value={v}>
                  {INTERVAL_LABEL[v]}
                </option>
              ))}
            </select>
            <button
              onClick={() => void probe()}
              disabled={probing || pending}
              title={pending ? "先把上一个问题答了（或跳过）" : "让面试官现在就问一个"}
              className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
            >
              {probing ? "想问题中…" : "再问我一个"}
            </button>
          </div>
        </div>

        {last ? (
          <div className="mt-3 rounded-xl border border-amber-200 bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-relaxed text-slate-800">{last.question}</p>
              <button
                onClick={() => void speak(last.question)}
                className="shrink-0 rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 hover:border-amber-300"
              >
                🔊
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {KIND_LABEL[last.kind] ?? last.kind}
              {last.zh && ` · ${last.zh}`}
            </p>
            {ttsBlocked && (
              <p className="mt-1 text-[11px] text-amber-600">浏览器拦了自动播放，点上面的 🔊 听。</p>
            )}

            {last.answered ? (
              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                {last.answer ? `已答：${last.answer}` : "跳过了（复盘时会算没答上）"}
              </p>
            ) : (
              <div className="mt-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder="口头答一句（可以直接说，点下面的话筒）"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-amber-300"
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => closeTurn(draft.trim())}
                    disabled={!draft.trim()}
                    className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
                  >
                    答完了
                  </button>
                  {canRecord && (
                    <button
                      onClick={recording ? stopRec : startRec}
                      disabled={transcribing}
                      className={`rounded-lg border px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                        recording
                          ? "border-rose-300 bg-rose-50 text-rose-600"
                          : "border-slate-200 text-slate-500 hover:border-amber-300"
                      }`}
                    >
                      {transcribing ? "转写中…" : recording ? "⏹ 停止录音" : "🎤 说出来"}
                    </button>
                  )}
                  <button onClick={() => closeTurn("")} className="text-xs text-slate-400 hover:text-slate-600">
                    答不上来，跳过
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            {interval > 0
              ? `先动手写，${INTERVAL_LABEL[interval].replace("每 ", "")}左右会问你第一个问题。`
              : "自动追问关着，想被问就点「再问我一个」。"}
          </p>
        )}

        {turns.length > 1 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-amber-700">看前面问过的 {turns.length - 1} 个</summary>
            <ol className="mt-2 space-y-1.5">
              {turns.slice(0, -1).map((t, i) => (
                <li key={i} className="rounded-lg bg-white/70 px-3 py-2 text-xs">
                  <p className="text-slate-700">
                    {i + 1}. {t.question}
                  </p>
                  <p className="mt-0.5 text-slate-400">{t.answer ? `我答：${t.answer}` : "（没答上）"}</p>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      {/* 编辑器 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-500">
            💻 在这儿写（Tab 缩进、括号自动配对、回车跟随缩进）
          </p>
          <span className="text-[11px] text-slate-400">
            {codeIsEmpty(code, problem?.starterCode ?? "") ? "还没动手" : `${code.length} 字符`}
          </span>
        </div>
        <textarea
          ref={areaRef}
          value={code}
          onChange={onCodeChange}
          onKeyDown={onKeyDown}
          spellCheck={false}
          rows={18}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[13px] leading-6 text-slate-800 outline-none focus:border-indigo-300"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => {
              if (window.confirm("放弃这一场？代码和问答都不会保存。")) setPhase("setup");
            }}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            放弃这一场
          </button>
          <button
            onClick={finish}
            disabled={submitting}
            className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? "面试官在复盘……" : "交卷，让面试官点评"}
          </button>
        </div>
      </div>

      {/* 复盘 */}
      {phase === "done" && review && (
        <ReviewPanel
          review={review}
          turns={turns}
          code={code}
          solution={solution}
          showSolution={showSolution}
          onToggleSolution={() => setShowSolution((v) => !v)}
          durationSec={elapsedSec(startedAt, Date.now())}
          onAgain={() => setPhase("setup")}
          onSpeak={(t) => void speak(t)}
        />
      )}
    </div>
  );
}

/* ============================ 复盘面板 ============================ */

function ReviewPanel({
  review,
  turns,
  solution,
  showSolution,
  onToggleSolution,
  durationSec,
  onAgain,
  onSpeak,
}: {
  review: MockReview;
  turns: Turn[];
  code: string;
  solution: string;
  showSolution: boolean;
  onToggleSolution: () => void;
  durationSec: number;
  onAgain: () => void;
  onSpeak: (text: string) => void;
}) {
  const meta = VERDICT_META[review.verdict] ?? VERDICT_META.ok;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">📝 面试官点评</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">用时 {formatDuration(durationSec)}</span>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
        </div>
      </div>

      <Section title="代码正确性">{review.correctness}</Section>
      {review.complexity && <Section title="复杂度">{review.complexity}</Section>}

      {review.issues.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-500">具体问题</p>
          <ul className="mt-1 space-y-1">
            {review.issues.map((s, i) => (
              <li key={i} className="rounded-lg bg-rose-50/60 px-3 py-1.5 text-sm text-slate-700">
                · {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.qaComments.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-500">追问答得怎么样</p>
          <ol className="mt-1 space-y-1.5">
            {review.qaComments.map((c, i) => {
              const t = turns[c.index - 1];
              return (
                <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  {t && <p className="text-xs text-slate-500">{t.question}</p>}
                  <p className="mt-0.5 text-slate-700">{c.comment}</p>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {review.nextSteps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-500">下次这么练</p>
          <ul className="mt-1 space-y-1">
            {review.nextSteps.map((s, i) => (
              <li key={i} className="rounded-lg bg-emerald-50/60 px-3 py-1.5 text-sm text-slate-700">
                · {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.modelAnswer && (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500">这道题该怎么口述（英文范本）</p>
            <button
              onClick={() => onSpeak(review.modelAnswer)}
              className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 hover:border-indigo-300"
            >
              🔊 念一遍
            </button>
          </div>
          <p className="mt-1 whitespace-pre-wrap rounded-xl bg-indigo-50/60 p-3 text-sm leading-relaxed text-slate-700">
            {review.modelAnswer}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={onAgain}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
        >
          再来一道 →
        </button>
        {solution && (
          <button
            onClick={onToggleSolution}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300"
          >
            {showSolution ? "收起参考解法" : "看参考解法"}
          </button>
        )}
      </div>
      {showSolution && solution && (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 p-3 font-mono text-[13px] leading-6 text-slate-100">
          {solution}
        </pre>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-slate-500">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{children}</p>
    </div>
  );
}

/* ============================ 历史面试 ============================ */

function HistoryList({
  history,
  openId,
  onToggle,
  onDelete,
}: {
  history: Session[] | null;
  openId: number | null;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  if (history === null) return <p className="text-sm text-slate-400">正在加载历史面试……</p>;
  if (!history.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">历史面试（{history.length}）</p>
      <p className="mt-0.5 text-xs text-slate-400">点开看当时写的代码、被问了什么、面试官怎么评的。</p>
      <div className="mt-3 space-y-1.5">
        {history.map((s) => {
          const meta = VERDICT_META[s.verdict] ?? VERDICT_META.ok;
          const open = openId === s.id;
          return (
            <div key={s.id} className="rounded-lg border border-slate-100">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <button onClick={() => onToggle(s.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="truncate text-sm text-slate-700">{s.title}</span>
                  <span className="shrink-0 text-[10px] text-slate-300">{open ? "▲" : "▼"}</span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-slate-400">
                    {s.turns.length} 问 · {formatDuration(s.durationSec)}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                  <button onClick={() => onDelete(s.id)} className="text-xs text-slate-400 hover:text-rose-500">
                    删除
                  </button>
                </div>
              </div>
              {open && (
                <div className="space-y-3 border-t border-slate-100 px-3 py-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-500">当时写的</p>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-5 text-slate-100">
                      {s.code || "（一个字没写）"}
                    </pre>
                  </div>
                  {s.turns.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-slate-500">被问了什么</p>
                      <ol className="mt-1 space-y-1">
                        {s.turns.map((t, i) => (
                          <li key={i} className="rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                            <p className="text-slate-700">
                              {i + 1}. {t.question}
                            </p>
                            <p className="text-slate-400">{t.answer ? `我答：${t.answer}` : "（没答上）"}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {s.review && (
                    <div className="text-sm text-slate-700">
                      <p className="text-xs font-semibold text-slate-500">点评</p>
                      <p className="mt-1 whitespace-pre-wrap">{s.review.correctness}</p>
                      {s.review.complexity && <p className="mt-1 whitespace-pre-wrap text-slate-600">{s.review.complexity}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
