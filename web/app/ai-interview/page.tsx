"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  LiveCapture,
  listAudioInputs,
  type Channel,
  type InterviewerSource,
  type Segment,
} from "@/lib/aiInterview/audio";
import { detectQuestion, type Detected, type QuestionKind } from "@/lib/aiInterview/question";
import {
  MODES,
  MODE_LABELS,
  type AnswerKind,
  type Lang,
  type Mode,
  type SessionMeta,
  type Style,
  type Turn,
} from "@/lib/aiInterview/schema";
import { readSse } from "@/lib/aiInterview/stream";
import { insertTurn, toMarkdown, windowFor } from "@/lib/aiInterview/transcript";

/**
 * AI 辅助面试:面试进行中,一边听「面试官的声音 + 我的麦克风」并实时转写,
 * 一边在检测到面试官提问的瞬间,按我的简历 / JD 生成一段可以直接照着说的话。
 *
 * 听音与切句在 lib/aiInterview/audio.ts(WebAudio + VAD),
 * 「这句是不是在问我」在 question.ts(纯规则,不花模型时间),
 * 回答与截屏解题走 /api/ai-interview/* 的 SSE 流式接口。
 */

/* ============================ 常量 / 小工具 ============================ */

type Phase = "setup" | "live" | "review";
type AnswerSource = "voice" | "screen" | "manual";

const KIND_LABEL: Record<QuestionKind, string> = {
  behavioral: "行为题",
  technical: "技术题",
  coding: "算法题",
  logistics: "流程/待遇",
  smalltalk: "寒暄",
  unclear: "没听清",
};

const ANSWER_LABEL: Record<AnswerKind, string> = {
  answer: "建议这样说",
  detail: "说得更细",
  rephrase: "换个说法",
  ask: "可以反问他们",
};

/** 自动回答的防抖:面试官一句话常被切成两三段,等他真的停下来再触发。 */
const AUTO_DEBOUNCE_MS = 700;
/** 面试中每隔多久把字幕存一次库 */
const AUTOSAVE_MS = 30_000;
/** 同时最多几个转写请求在飞(再多也不丢,只是排队) */
const MAX_INFLIGHT = 4;

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stamp(ms: number): string {
  return fmtClock(ms);
}

/** 从简历 / JD 里抽一小段专有名词,喂给转写当提示,技术词不容易被听错。 */
function buildHint(resume: string, jd: string, company: string): string {
  const source = `${company} ${jd.slice(0, 1_500)} ${resume.slice(0, 2_500)}`;
  const seen = new Set<string>();
  const terms: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9+#.]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const t = m[0];
    const key = t.toLowerCase();
    // 只留大写开头 / 含数字或符号的词:这类才是技术名词与产品名。
    if (!/^[A-Z]/.test(t) && !/[0-9+#.]/.test(t)) continue;
    if (seen.has(key) || key.length < 3) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= 60) break;
  }
  return terms.join(", ");
}

/* ============================ 页面 ============================ */

export default function AiInterviewPage() {
  /* ---- 配置 ---- */
  const [mode, setMode] = useState<Mode>("tech");
  const [lang, setLang] = useState<Lang>("en");
  const [style, setStyle] = useState<Style>("short");
  const [company, setCompany] = useState("");
  const [jd, setJd] = useState("");
  const [notes, setNotes] = useState("");
  const [resume, setResume] = useState("");
  const [resumeName, setResumeName] = useState("");
  const [resumeLoading, setResumeLoading] = useState(false);
  const [sourceKind, setSourceKind] = useState<"display" | "device">("display");
  const [deviceId, setDeviceId] = useState("");
  const [useMic, setUseMic] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [autoAnswer, setAutoAnswer] = useState(true);

  /* ---- 运行时 ---- */
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [levels, setLevels] = useState<Record<Channel, number>>({ interviewer: 0, me: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState(0);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerKind, setAnswerKind] = useState<AnswerKind>("answer");
  const [answerSource, setAnswerSource] = useState<AnswerSource>("voice");
  const [streaming, setStreaming] = useState(false);
  const [manualQuestion, setManualQuestion] = useState("");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [summary, setSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [history, setHistory] = useState<SessionMeta[]>([]);
  const [viewing, setViewing] = useState<{ title: string; turns: Turn[]; summary: string } | null>(
    null,
  );

  /* ---- refs(异步回调里要读最新值) ---- */
  const capRef = useRef<LiveCapture | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const cfgRef = useRef({ mode, lang, style, company, jd, notes, resume, autoAnswer });
  const abortRef = useRef<AbortController | null>(null);
  /** 自动回答的到点时间(performance.now 基准);由音频心跳检查,不用 setTimeout —— 见下 */
  const autoDueRef = useRef<number | null>(null);
  const runAnswerRef = useRef<
    (kind: AnswerKind, question: string, qKind?: QuestionKind, isFollowUp?: boolean) => void
  >(() => {});
  const lastAnsweredRef = useRef("");
  const inflightRef = useRef(0);
  const answerRef = useRef("");
  const sessionIdRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    cfgRef.current = { mode, lang, style, company, jd, notes, resume, autoAnswer };
  }, [mode, lang, style, company, jd, notes, resume, autoAnswer]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  /* ============================ 初始化 ============================ */

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/ai-interview/sessions");
      const data = (await res.json()) as { success?: boolean; sessions?: SessionMeta[] };
      if (data.success && data.sessions) setHistory(data.sessions);
    } catch {
      /* 历史记录拿不到不影响用 */
    }
  }, []);

  const loadResume = useCallback(async (file?: File) => {
    setResumeLoading(true);
    setError("");
    try {
      const body = new FormData();
      if (file) body.append("file", file);
      const res = await fetch("/api/ai-interview/resume-text", { method: "POST", body });
      const data = (await res.json()) as { success?: boolean; text?: string; name?: string; error?: string };
      if (!data.success || !data.text) throw new Error(data.error || "简历解析失败");
      setResume(data.text);
      setResumeName(data.name || file?.name || "简历");
    } catch (err) {
      setError(err instanceof Error ? err.message : "简历解析失败");
    } finally {
      setResumeLoading(false);
    }
  }, []);

  // 进页面就把默认简历和历史记录准备好。
  useEffect(() => {
    void loadResume();
    void loadHistory();
  }, [loadResume, loadHistory]);

  // 计时器
  useEffect(() => {
    if (phase !== "live") return;
    const id = window.setInterval(() => setElapsed(capRef.current?.elapsed ?? 0), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listAudioInputs());
    } catch {
      /* 没权限就先空着,点开始时会再要一次 */
    }
  }, []);
  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  /* ============================ 保存 ============================ */

  const save = useCallback(async (opts: { end?: boolean } = {}) => {
    const id = sessionIdRef.current;
    if (!id) return;
    if (!dirtyRef.current && !opts.end) return;
    dirtyRef.current = false;
    try {
      await fetch(`/api/ai-interview/sessions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turns: turnsRef.current, ...(opts.end ? { end: true } : {}) }),
      });
    } catch {
      dirtyRef.current = true; // 下次再试
    }
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    const id = window.setInterval(() => void save(), AUTOSAVE_MS);
    return () => window.clearInterval(id);
  }, [phase, save]);

  /* ============================ 生成回答 ============================ */

  const runAnswer = useCallback(
    async (kind: AnswerKind, question: string, qKind?: QuestionKind, isFollowUp = false) => {
      const cfg = cfgRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setAnswerKind(kind);
      setAnswerSource(kind === "answer" ? (question ? "voice" : "manual") : answerSource);
      setStreaming(true);
      setAnswer("");
      setError("");
      if (kind === "answer" || kind === "detail") lastAnsweredRef.current = question;

      try {
        const res = await fetch("/api/ai-interview/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            mode: cfg.mode,
            lang: cfg.lang,
            style: cfg.style,
            kind,
            question,
            questionKind: qKind,
            isFollowUp,
            // 建议答案不进模型窗口:我实际说了什么由麦克风通道记录,窗口保持干净。
            window: windowFor(
              turnsRef.current.filter((t) => t.role !== "assistant"),
              turnsRef.current.length ? turnsRef.current[turnsRef.current.length - 1].at : 0,
            ),
            prevAnswer: kind === "detail" || kind === "rephrase" ? answerRef.current : "",
            profile: { resume: cfg.resume, jd: cfg.jd, notes: cfg.notes, company: cfg.company },
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || "生成失败,请重试。");
        }
        const full = await readSse(res, (event) => {
          if (event.t === "delta") setAnswer((prev) => prev + event.v);
          else if (event.t === "error") setError(event.v);
        });
        if (full.trim() && kind !== "ask") {
          // 记进全文,复盘时能看到「当时 AI 建议怎么说」。
          const at = Math.round(capRef.current?.elapsed ?? 0);
          setTurns((prev) => {
            const next = insertTurn(prev, { role: "assistant", text: full.trim(), at });
            turnsRef.current = next;
            dirtyRef.current = true;
            return next;
          });
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : "生成失败,请重试。");
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setStreaming(false);
        }
      }
    },
    [answerSource],
  );

  useEffect(() => {
    runAnswerRef.current = (kind, question, qKind, isFollowUp = false) =>
      void runAnswer(kind, question, qKind, isFollowUp);
  }, [runAnswer]);

  /**
   * 面试官那一段转写回来后,推迟一点再判「他是不是在问我」——
   * 一句话常被切成两三段,等他真的停下来再触发,否则会拿半句去生成。
   * 到点由音频心跳检查(见 onHeartbeat):这个页面在面试时很可能被会议窗口挡住,
   * 而隐藏标签页的 setTimeout 会被 Chrome 压到 1 秒甚至 1 分钟一次,答案就迟到了。
   */
  const scheduleAuto = useCallback(() => {
    autoDueRef.current = performance.now() + AUTO_DEBOUNCE_MS;
  }, []);

  /** 音频线程驱动的心跳:到点就做提问判定 / 自动回答(不受标签页节流影响)。 */
  const onHeartbeat = useCallback((now: number) => {
    const due = autoDueRef.current;
    if (due === null || now < due) return;
    autoDueRef.current = null;
    const found = detectQuestion(turnsRef.current, lastAnsweredRef.current);
    setDetected(found.question ? found : null);
    if (!cfgRef.current.autoAnswer) return;
    if (!found.shouldAnswer) return;
    if (found.question === lastAnsweredRef.current) return;
    runAnswerRef.current("answer", found.question, found.kind, found.isFollowUp);
  }, []);

  /* ============================ 转写 ============================ */

  const transcribe = useCallback(
    async (segment: Segment) => {
      const cfg = cfgRef.current;
      const form = new FormData();
      form.append("audio", segment.blob, `seg.${segment.ext}`);
      form.append("language", cfg.lang);
      form.append("hint", buildHint(cfg.resume, cfg.jd, cfg.company));

      inflightRef.current += 1;
      setPending(inflightRef.current);
      try {
        const res = await fetch("/api/ai-interview/transcribe", { method: "POST", body: form });
        const data = (await res.json()) as { success?: boolean; text?: string; error?: string };
        if (!data.success) throw new Error(data.error || "转写失败");
        const text = (data.text || "").trim();
        if (!text) return;
        const role = segment.channel === "interviewer" ? "interviewer" : "me";
        setTurns((prev) => {
          const next = insertTurn(prev, { role, text, at: segment.startedAt });
          turnsRef.current = next;
          dirtyRef.current = true;
          return next;
        });
        if (role === "interviewer") scheduleAuto();
      } catch (err) {
        setError(err instanceof Error ? err.message : "转写失败");
      } finally {
        inflightRef.current = Math.max(0, inflightRef.current - 1);
        setPending(inflightRef.current);
      }
    },
    [scheduleAuto],
  );

  /* ============================ 开始 / 结束 ============================ */

  const start = useCallback(async () => {
    setError("");
    setNotice("");
    const capture = new LiveCapture({
      onSegment: (segment) => void transcribe(segment),
      onLevel: (channel, level) => setLevels((prev) => ({ ...prev, [channel]: level })),
      onError: (_channel, message) => setError(message),
      onEnded: () => setNotice("共享或设备已停止 —— 若面试还在继续,请结束本场后重新开始。"),
      onHeartbeat,
    });

    try {
      // 先要屏幕/设备(getDisplayMedia 必须紧跟用户点击),再要麦克风。
      const source: InterviewerSource =
        sourceKind === "device"
          ? { kind: "device", deviceId }
          : { kind: "display" };
      if (source.kind === "device" && !deviceId) {
        throw new Error("请先选择面试官声音所在的输入设备。");
      }
      await capture.startInterviewer(source);
      if (useMic) {
        try {
          await capture.startMic();
        } catch {
          setNotice("没拿到麦克风权限:只听面试官,不会记录你自己说的话。");
        }
      }
    } catch (err) {
      capture.stop();
      const message =
        err instanceof Error
          ? err.name === "NotAllowedError"
            ? "已取消共享/授权,没有开始。"
            : err.message
          : "开始失败";
      setError(message);
      return;
    }

    capRef.current = capture;
    setTurns([]);
    turnsRef.current = [];
    setAnswer("");
    setDetected(null);
    lastAnsweredRef.current = "";
    setSummary("");
    setElapsed(0);
    setPhase("live");
    void refreshDevices();

    try {
      const res = await fetch("/api/ai-interview/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, lang, company, jd, notes }),
      });
      const data = (await res.json()) as { success?: boolean; id?: number };
      if (data.success && data.id) setSessionId(data.id);
      else setNotice("没能建会话记录(数据库不可用),这场不会存档,但功能照常用。");
    } catch {
      setNotice("没能建会话记录(数据库不可用),这场不会存档,但功能照常用。");
    }
  }, [
    company,
    deviceId,
    jd,
    lang,
    mode,
    notes,
    onHeartbeat,
    refreshDevices,
    sourceKind,
    transcribe,
    useMic,
  ]);

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    autoDueRef.current = null;
    capRef.current?.stop();
    capRef.current = null;
    setStreaming(false);
    setPhase("review");
    setLevels({ interviewer: 0, me: 0 });
    // 收尾的最后一段音频还在转写,稍等一下再存,免得漏掉最后一句。
    window.setTimeout(() => {
      dirtyRef.current = true;
      void save({ end: true }).then(loadHistory);
    }, 2_500);
  }, [loadHistory, save]);

  // 页面被关掉/刷新时尽量把记录留住。
  useEffect(() => {
    const onLeave = () => {
      const id = sessionIdRef.current;
      if (!id || !turnsRef.current.length) return;
      navigator.sendBeacon?.(
        `/api/ai-interview/sessions/${id}`,
        new Blob([JSON.stringify({ turns: turnsRef.current })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, []);

  useEffect(() => () => capRef.current?.stop(), []);

  /* ============================ 截屏解题 ============================ */

  const screenshotAnswer = useCallback(async () => {
    const capture = capRef.current;
    if (!capture) return;
    setError("");
    try {
      if (!capture.canScreenshot) await capture.startScreenOnly();
      const image = await capture.screenshot();
      if (!image) throw new Error("没抓到画面,请确认共享还在进行。");

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const cfg = cfgRef.current;
      setAnswerSource("screen");
      setAnswerKind("answer");
      setStreaming(true);
      setAnswer("");

      const res = await fetch("/api/ai-interview/coding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          image,
          lang: cfg.lang,
          question: detected?.question || manualQuestion,
          window: windowFor(
            turnsRef.current.filter((t) => t.role !== "assistant"),
            turnsRef.current.length ? turnsRef.current[turnsRef.current.length - 1].at : 0,
            120,
            24,
          ),
          profile: { resume: cfg.resume, jd: cfg.jd, notes: cfg.notes, company: cfg.company },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || "解题失败,请重试。");
      }
      await readSse(res, (event) => {
        if (event.t === "delta") setAnswer((prev) => prev + event.v);
        else if (event.t === "error") setError(event.v);
      });
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "解题失败");
      }
    } finally {
      setStreaming(false);
    }
  }, [detected, manualQuestion]);

  /* ============================ 快捷键 ============================ */

  useEffect(() => {
    if (phase !== "live") return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const q = detected?.question || manualQuestion;
      if (e.code === "KeyA") {
        e.preventDefault();
        void runAnswer("answer", q, detected?.kind, detected?.isFollowUp);
      } else if (e.code === "KeyD") {
        e.preventDefault();
        if (answerRef.current) void runAnswer("detail", q, detected?.kind, true);
      } else if (e.code === "KeyR") {
        e.preventDefault();
        if (answerRef.current) void runAnswer("rephrase", q, detected?.kind);
      } else if (e.code === "KeyS") {
        e.preventDefault();
        void screenshotAnswer();
      } else if (e.code === "KeyQ") {
        e.preventDefault();
        void runAnswer("ask", "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detected, manualQuestion, phase, runAnswer, screenshotAnswer]);

  /* ============================ 复盘 / 导出 ============================ */

  const makeSummary = useCallback(async () => {
    setSummaryLoading(true);
    setError("");
    try {
      const res = await fetch("/api/ai-interview/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionIdRef.current, turns: turnsRef.current, jd, company }),
      });
      const data = (await res.json()) as { success?: boolean; summary?: string; error?: string };
      if (!data.success || !data.summary) throw new Error(data.error || "总结失败");
      setSummary(data.summary);
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "总结失败");
    } finally {
      setSummaryLoading(false);
    }
  }, [company, jd, loadHistory]);

  const exportMd = useCallback(
    (data?: { title: string; turns: Turn[]; summary: string }) => {
      const md = toMarkdown({
        title: data?.title || `${company || "面试"} · AI 辅助面试`,
        company,
        mode: MODE_LABELS[mode].name,
        startedAt: new Date().toLocaleString("zh-CN"),
        summary: data?.summary ?? summary,
        turns: data?.turns ?? turnsRef.current,
      });
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `interview-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [company, mode, summary],
  );

  const openSession = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/ai-interview/sessions/${id}`);
      const data = (await res.json()) as {
        success?: boolean;
        session?: { title: string; turns: Turn[]; summary: string };
      };
      if (data.success && data.session) {
        setViewing({
          title: data.session.title,
          turns: data.session.turns,
          summary: data.session.summary,
        });
      }
    } catch {
      setError("打开记录失败");
    }
  }, []);

  const removeSession = useCallback(
    async (id: number) => {
      if (!window.confirm("删除这场面试记录?不可恢复。")) return;
      try {
        await fetch(`/api/ai-interview/sessions/${id}`, { method: "DELETE" });
        if (sessionIdRef.current === id) setSessionId(null);
        setViewing(null);
        void loadHistory();
      } catch {
        setError("删除失败");
      }
    },
    [loadHistory],
  );

  /* ============================ 派生 ============================ */

  const question = detected?.question || "";
  const stats = useMemo(() => {
    const asked = turns.filter((t) => t.role === "interviewer").length;
    const said = turns.filter((t) => t.role === "me").length;
    return { asked, said };
  }, [turns]);

  /* ============================ 渲染 ============================ */

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6">
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
            ← 返回工具箱
          </Link>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            AI 辅助面试
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-500">
            面试进行中,实时听「面试官的声音 + 你的麦克风」并转写;一检测到对方在提问,就按你的简历和
            JD 生成一段可以直接照着说的话。算法题可以直接截屏,让它读题给解法。全程只在这台机器上开,
            不动会议软件本身。
          </p>
        </header>

        {(error || notice) && (
          <div className="mb-4 space-y-2">
            {error && (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <span>{error}</span>
                <button onClick={() => setError("")} className="text-rose-400 hover:text-rose-600">
                  ✕
                </button>
              </div>
            )}
            {notice && (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <span>{notice}</span>
                <button onClick={() => setNotice("")} className="text-amber-500 hover:text-amber-700">
                  ✕
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "setup" ? (
          <SetupPanel
            {...{
              mode,
              setMode,
              lang,
              setLang,
              style,
              setStyle,
              company,
              setCompany,
              jd,
              setJd,
              notes,
              setNotes,
              resume,
              resumeName,
              resumeLoading,
              loadResume,
              sourceKind,
              setSourceKind,
              deviceId,
              setDeviceId,
              devices,
              refreshDevices,
              useMic,
              setUseMic,
              autoAnswer,
              setAutoAnswer,
              start,
            }}
          />
        ) : (
          <>
            <LiveBar
              phase={phase}
              elapsed={elapsed}
              levels={levels}
              pending={pending}
              stats={stats}
              autoAnswer={autoAnswer}
              setAutoAnswer={setAutoAnswer}
              onStop={stop}
              onRestart={() => {
                setPhase("setup");
                setViewing(null);
              }}
            />

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <TranscriptPanel turns={turns} />
              <AnswerPanel
                {...{
                  phase,
                  question,
                  detected,
                  answer,
                  answerKind,
                  answerSource,
                  streaming,
                  manualQuestion,
                  setManualQuestion,
                  onAnswer: () =>
                    void runAnswer(
                      "answer",
                      manualQuestion.trim() || question,
                      detected?.kind,
                      detected?.isFollowUp,
                    ),
                  onDetail: () => void runAnswer("detail", question, detected?.kind, true),
                  onRephrase: () => void runAnswer("rephrase", question, detected?.kind),
                  onAsk: () => void runAnswer("ask", ""),
                  onScreenshot: () => void screenshotAnswer(),
                  onStopStream: () => abortRef.current?.abort(),
                }}
              />
            </div>

            {phase === "review" && (
              <ReviewPanel
                summary={summary}
                loading={summaryLoading}
                turnCount={turns.length}
                onSummary={makeSummary}
                onExport={() => exportMd()}
              />
            )}
          </>
        )}

        <HistoryPanel
          sessions={history}
          onOpen={openSession}
          onDelete={removeSession}
          viewing={viewing}
          onCloseViewing={() => setViewing(null)}
          onExportViewing={exportMd}
        />

        <footer className="mt-10 text-center text-xs text-slate-300">
          Autoxhs · AI 辅助面试(灵感来自 natively-cluely-ai-assistant,浏览器版实现)
        </footer>
      </div>
    </main>
  );
}

/* ============================ 子组件 ============================ */

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {hint && <span className="ml-2 text-xs text-slate-400">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const INPUT =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition focus:border-slate-400";

type SetupProps = {
  mode: Mode;
  setMode: (m: Mode) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  style: Style;
  setStyle: (s: Style) => void;
  company: string;
  setCompany: (v: string) => void;
  jd: string;
  setJd: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  resume: string;
  resumeName: string;
  resumeLoading: boolean;
  loadResume: (file?: File) => Promise<void>;
  sourceKind: "display" | "device";
  setSourceKind: (v: "display" | "device") => void;
  deviceId: string;
  setDeviceId: (v: string) => void;
  devices: MediaDeviceInfo[];
  refreshDevices: () => Promise<void>;
  useMic: boolean;
  setUseMic: (v: boolean) => void;
  autoAnswer: boolean;
  setAutoAnswer: (v: boolean) => void;
  start: () => Promise<void>;
};

function SetupPanel(p: SetupProps) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">① 这场面试是什么</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="模式">
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m}
                  onClick={() => p.setMode(m)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                    p.mode === m
                      ? "border-blue-400 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  }`}
                >
                  <span className="font-medium">{MODE_LABELS[m].name}</span>
                  <span className="mt-0.5 block text-xs text-slate-400">{MODE_LABELS[m].desc}</span>
                </button>
              ))}
            </div>
          </Field>
          <div className="space-y-4">
            <Field label="回答语言">
              <div className="flex gap-2">
                {(["en", "zh"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => p.setLang(l)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
                      p.lang === l
                        ? "border-blue-400 bg-blue-50 text-blue-700"
                        : "border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {l === "en" ? "English" : "中文"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="答案长度" hint="面试里默认短一点,好照着说">
              <div className="flex gap-2">
                {(["short", "detailed"] as Style[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => p.setStyle(s)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
                      p.style === s
                        ? "border-blue-400 bg-blue-50 text-blue-700"
                        : "border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {s === "short" ? "简短(2~4 句)" : "完整(约 150 词)"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="公司 / 岗位名">
              <input
                className={INPUT}
                value={p.company}
                onChange={(e) => p.setCompany(e.target.value)}
                placeholder="如 Amazon · Senior Java Developer"
              />
            </Field>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">② 答案的事实依据</h2>
        <p className="mt-1 text-xs text-slate-400">
          回答只会用这里的内容当事实,不会替你编经历。简历只在生成时用,不会存进数据库。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="简历" hint={p.resumeLoading ? "解析中…" : p.resumeName || "未加载"}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void p.loadResume()}
                disabled={p.resumeLoading}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300 disabled:opacity-50"
              >
                用默认简历
              </button>
              <label className="cursor-pointer rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300">
                换一份(PDF/DOCX)
                <input
                  type="file"
                  accept=".pdf,.docx"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void p.loadResume(file);
                  }}
                />
              </label>
              {p.resume && (
                <span className="text-xs text-emerald-600">已就绪 · {p.resume.length} 字</span>
              )}
            </div>
          </Field>
          <Field label="备忘" hint="想强调的项目、薪资底线、面试官名字…">
            <textarea
              className={`${INPUT} h-20 resize-y`}
              value={p.notes}
              onChange={(e) => p.setNotes(e.target.value)}
              placeholder="例:主推支付重构项目;期望 165k,可谈股票;不接受纯 oncall 岗"
            />
          </Field>
        </div>
        <Field label="目标 JD">
          <textarea
            className={`${INPUT} mt-4 h-28 resize-y`}
            value={p.jd}
            onChange={(e) => p.setJd(e.target.value)}
            placeholder="粘贴岗位描述,答案会往这些要求上靠"
          />
        </Field>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">③ 怎么听到面试官</h2>
        <div className="mt-4 space-y-3">
          <button
            onClick={() => p.setSourceKind("display")}
            className={`w-full rounded-xl border p-4 text-left transition ${
              p.sourceKind === "display"
                ? "border-blue-400 bg-blue-50"
                : "border-slate-200 hover:border-slate-300"
            }`}
          >
            <div className="text-sm font-medium text-slate-800">
              共享标签页音频(推荐 · 网页版会议)
            </div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500">
              点开始后在选择器里选 <b>Chrome 标签页</b>(面试所在那个标签页),并勾选
              <b>「同时分享标签页音频」</b>。适用于 Zoom Web / Google Meet / Teams Web / HackerRank。
              顺带拿到画面,可以直接截屏解题。选「整个屏幕」在 macOS 上拿不到声音。
            </div>
          </button>
          <button
            onClick={() => p.setSourceKind("device")}
            className={`w-full rounded-xl border p-4 text-left transition ${
              p.sourceKind === "device"
                ? "border-blue-400 bg-blue-50"
                : "border-slate-200 hover:border-slate-300"
            }`}
          >
            <div className="text-sm font-medium text-slate-800">虚拟声卡 / 指定输入设备(桌面客户端)</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500">
              面试用的是桌面版 Zoom / Teams 时:装 BlackHole 之类的虚拟声卡,把会议声音输出到它,
              这里选它作为输入。截屏解题会在你按下时另外申请一次共享。
            </div>
          </button>
          {p.sourceKind === "device" && (
            <Field label="输入设备">
              <div className="flex gap-2">
                <select
                  className={INPUT}
                  value={p.deviceId}
                  onChange={(e) => p.setDeviceId(e.target.value)}
                >
                  <option value="">请选择…</option>
                  {p.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `设备 ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void p.refreshDevices()}
                  className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:border-slate-300"
                >
                  刷新
                </button>
              </div>
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-5 pt-1">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={p.useMic}
                onChange={(e) => p.setUseMic(e.target.checked)}
              />
              同时听我的麦克风(记录我说了什么,复盘用)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={p.autoAnswer}
                onChange={(e) => p.setAutoAnswer(e.target.checked)}
              />
              听到提问就自动生成答案
            </label>
          </div>
        </div>

        <button
          onClick={() => void p.start()}
          className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          开始 · 现在共享面试所在的标签页
        </button>
        <p className="mt-2 text-center text-xs text-slate-400">
          开始后浏览器会弹共享选择器;整场只在本机运行,音频片段只发给 OpenAI 转写。
        </p>
      </section>
    </div>
  );
}

function Meter({ label, level, on }: { label: string; level: number; on: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs ${on ? "text-slate-600" : "text-slate-300"}`}>{label}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            on ? "bg-emerald-500" : "bg-slate-300"
          }`}
          style={{ width: `${Math.min(100, Math.round(level * 100))}%` }}
        />
      </div>
    </div>
  );
}

function LiveBar(p: {
  phase: Phase;
  elapsed: number;
  levels: Record<Channel, number>;
  pending: number;
  stats: { asked: number; said: number };
  autoAnswer: boolean;
  setAutoAnswer: (v: boolean) => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const live = p.phase === "live";
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <span
          className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-rose-500" : "bg-slate-300"}`}
        />
        {live ? "进行中" : "已结束"}
      </span>
      <span className="font-mono text-sm text-slate-600">{fmtClock(p.elapsed)}</span>
      <Meter label="面试官" level={p.levels.interviewer} on={live} />
      <Meter label="我" level={p.levels.me} on={live} />
      <span className="text-xs text-slate-400">
        提问 {p.stats.asked} · 我说 {p.stats.said}
        {p.pending > 0 && ` · 转写中 ${p.pending}`}
      </span>
      <label className="flex items-center gap-2 text-xs text-slate-500">
        <input
          type="checkbox"
          checked={p.autoAnswer}
          onChange={(e) => p.setAutoAnswer(e.target.checked)}
        />
        自动回答
      </label>
      <div className="ml-auto flex gap-2">
        {live ? (
          <button
            onClick={p.onStop}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            结束面试
          </button>
        ) : (
          <button
            onClick={p.onRestart}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            再开一场
          </button>
        )}
      </div>
    </div>
  );
}

function TranscriptPanel({ turns }: { turns: Turn[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [turns]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">实时字幕</h2>
        <span className="text-xs text-slate-400">{turns.length} 条</span>
      </div>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="h-[420px] space-y-2.5 overflow-y-auto pr-1 lg:h-[560px]"
      >
        {!turns.length && (
          <p className="pt-16 text-center text-sm text-slate-400">
            还没听到内容。对方一说话就会出现在这里。
          </p>
        )}
        {turns.map((t, i) => (
          <div key={`${t.at}-${i}`} className="text-sm leading-relaxed">
            <span className="mr-2 font-mono text-[11px] text-slate-300">{stamp(t.at)}</span>
            {t.role === "interviewer" ? (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                面试官
              </span>
            ) : t.role === "me" ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
                我
              </span>
            ) : (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-600">
                AI 建议
              </span>
            )}
            <span
              className={`ml-2 ${t.role === "interviewer" ? "text-slate-800" : "text-slate-500"}`}
            >
              {t.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnswerPanel(p: {
  phase: Phase;
  question: string;
  detected: Detected | null;
  answer: string;
  answerKind: AnswerKind;
  answerSource: AnswerSource;
  streaming: boolean;
  manualQuestion: string;
  setManualQuestion: (v: string) => void;
  onAnswer: () => void;
  onDetail: () => void;
  onRephrase: () => void;
  onAsk: () => void;
  onScreenshot: () => void;
  onStopStream: () => void;
}) {
  const live = p.phase === "live";
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">
          {p.answerSource === "screen" ? "截屏解题" : ANSWER_LABEL[p.answerKind]}
        </h2>
        {p.detected && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {KIND_LABEL[p.detected.kind]} · 置信度 {Math.round(p.detected.confidence * 100)}%
            {p.detected.isFollowUp ? " · 追问" : ""}
          </span>
        )}
        {p.streaming && (
          <button
            onClick={p.onStopStream}
            className="ml-auto rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:border-slate-300"
          >
            停止生成
          </button>
        )}
      </div>

      {p.question && (
        <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <span className="text-xs text-slate-400">听到的问题:</span> {p.question}
        </div>
      )}

      <div className="min-h-[220px] whitespace-pre-wrap text-[15px] leading-7 text-slate-900 lg:min-h-[380px]">
        {p.answer || (
          <span className="text-sm text-slate-400">
            {live
              ? "等对方提问 —— 检测到问题会自动出现在这里(也可以按 ⌥A 立刻要一份)。"
              : "这场已结束。"}
          </span>
        )}
        {p.streaming && <span className="ml-0.5 animate-pulse text-slate-400">▍</span>}
      </div>

      {live && (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={p.onAnswer}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              立即回答 <kbd className="ml-1 text-[10px] opacity-60">⌥A</kbd>
            </button>
            <button
              onClick={p.onDetail}
              disabled={!p.answer}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300 disabled:opacity-40"
            >
              说得更细 <kbd className="ml-1 text-[10px] opacity-50">⌥D</kbd>
            </button>
            <button
              onClick={p.onRephrase}
              disabled={!p.answer}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300 disabled:opacity-40"
            >
              换个说法 <kbd className="ml-1 text-[10px] opacity-50">⌥R</kbd>
            </button>
            <button
              onClick={p.onScreenshot}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300"
            >
              截屏解题 <kbd className="ml-1 text-[10px] opacity-50">⌥S</kbd>
            </button>
            <button
              onClick={p.onAsk}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300"
            >
              反问他们 <kbd className="ml-1 text-[10px] opacity-50">⌥Q</kbd>
            </button>
            <button
              onClick={() => void navigator.clipboard?.writeText(p.answer)}
              disabled={!p.answer}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300 disabled:opacity-40"
            >
              复制
            </button>
          </div>

          <div className="mt-3 flex gap-2">
            <input
              className={INPUT}
              value={p.manualQuestion}
              onChange={(e) => p.setManualQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") p.onAnswer();
              }}
              placeholder="没听清?直接把问题打在这里,回车生成"
            />
          </div>
        </>
      )}
    </section>
  );
}

function ReviewPanel(p: {
  summary: string;
  loading: boolean;
  turnCount: number;
  onSummary: () => void;
  onExport: () => void;
}) {
  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-slate-900">面试复盘</h2>
        <span className="text-xs text-slate-400">共 {p.turnCount} 条记录</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={p.onSummary}
            disabled={p.loading || p.turnCount < 2}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {p.loading ? "生成中…" : "生成复盘总结"}
          </button>
          <button
            onClick={p.onExport}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300"
          >
            导出 Markdown
          </button>
        </div>
      </div>
      {p.summary && (
        <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
          {p.summary}
        </pre>
      )}
    </section>
  );
}

function HistoryPanel(p: {
  sessions: SessionMeta[];
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  viewing: { title: string; turns: Turn[]; summary: string } | null;
  onCloseViewing: () => void;
  onExportViewing: (data: { title: string; turns: Turn[]; summary: string }) => void;
}) {
  if (!p.sessions.length && !p.viewing) return null;
  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">历史面试</h2>
      <div className="mt-3 divide-y divide-slate-100">
        {p.sessions.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
            <span className="font-medium text-slate-800">{s.title || "未命名"}</span>
            <span className="text-xs text-slate-400">
              {MODE_LABELS[s.mode].name} · {s.turnCount} 条 · {s.startedAt}
              {s.hasSummary ? " · 已复盘" : ""}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => void p.onOpen(s.id)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-slate-300"
              >
                查看
              </button>
              <button
                onClick={() => void p.onDelete(s.id)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-rose-500 hover:border-rose-300"
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {p.viewing && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-800">{p.viewing.title}</h3>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => p.onExportViewing(p.viewing!)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-slate-300"
              >
                导出 Markdown
              </button>
              <button
                onClick={p.onCloseViewing}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500 hover:border-slate-300"
              >
                关闭
              </button>
            </div>
          </div>
          {p.viewing.summary && (
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
              {p.viewing.summary}
            </pre>
          )}
          <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto text-sm">
            {p.viewing.turns.map((t, i) => (
              <div key={i}>
                <span className="mr-2 font-mono text-[11px] text-slate-300">{stamp(t.at)}</span>
                <span
                  className={
                    t.role === "interviewer"
                      ? "text-blue-600"
                      : t.role === "assistant"
                        ? "text-violet-600"
                        : "text-slate-500"
                  }
                >
                  {t.role === "interviewer" ? "面试官" : t.role === "me" ? "我" : "AI 建议"}:
                </span>
                <span className="ml-1 text-slate-700">{t.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
