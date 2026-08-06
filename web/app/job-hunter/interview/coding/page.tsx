"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import type { CodingTrace } from "@/lib/job-hunter/interview/schema";
import MockInterview from "./MockInterview";
import {
  applyInput,
  applyInputIde,
  calcAccuracy,
  codeSegments,
  dropClosedFrom,
  findSnippet,
  calcWpm,
  durationLabel,
  lineCount,
  normalizeCode,
  suggestGrade,
  tabSkip,
  type RecallGrade,
} from "@/lib/job-hunter/interview/typing";

/**
 * Coding 手感训练:把经典题的参考代码当成「跟打稿」,一个字一个字敲出来。
 * 答案默认以灰字铺在输入区(盲打模式可隐藏),敲对的字变亮、敲错不落字只记错,
 * 敲完记一次成绩(手速/正确率)并按遗忘曲线(FSRS)排下次再敲。
 */

/* ============================ 类型 / 常量 ============================ */

type SrState = "new" | "learning" | "young" | "mastered";

type Problem = {
  id: number;
  category: string;
  lang: string;
  title: string;
  prompt: string;
  promptEn: string;
  setup: string;
  solution: string;
  explanation: string;
  difficulty: number;
  source: string;
  runs: number;
  bestWpm: number;
  bestAccuracy: number;
  lastWpm: number;
  lastAccuracy: number;
  state: SrState;
  isDue: boolean;
  dueAt: string | null;
  intervalDays: number;
};

type Attempt = {
  id: number;
  wpm: number;
  accuracy: number;
  duration_sec: number;
  errors: number;
  mode: string;
  grade: string | null;
  created_at: string;
};

const CATEGORY_LABEL: Record<string, string> = {
  "java-lambda": "Java Lambda",
  mysql: "MySQL",
  mongodb: "MongoDB",
  design: "程序设计",
  algorithm: "算法",
};
const CATEGORY_ORDER = ["java-lambda", "mysql", "mongodb", "design", "algorithm"];

const SR_STATE_LABEL: Record<SrState, string> = { new: "新", learning: "学习中", young: "巩固中", mastered: "已熟练" };
const SR_STATE_CLASS: Record<SrState, string> = {
  new: "bg-sky-50 text-sky-600",
  learning: "bg-amber-50 text-amber-700",
  young: "bg-violet-50 text-violet-700",
  mastered: "bg-emerald-50 text-emerald-700",
};

const DIFFICULTY_LABEL: Record<number, string> = { 1: "简单", 2: "中等", 3: "偏难" };

const GRADE_LABEL: Record<RecallGrade, string> = { forgot: "还很生", vague: "凑合", clear: "很顺" };

/** 「IDE 模式(括号自动补全)」开关记在本地,默认开 */
type PageMode = "drill" | "mock";
const MODE_KEY = "coding:pageMode";

const IDE_MODE_KEY = "coding:ideMode";
/** 上次「加入猛攻题库」选的那份简历,下次直接用 */
const CRAM_SESSION_KEY = "coding:cramSession";

/** 猛攻版的简历列表(加入题库时选目标) */
type CramSummary = { id: number; title: string; total: number; due: number };

/* ============================ 页面 ============================ */

export default function CodingPage() {
  // 两种练法:跟打(照着参考答案敲手感)/ 面试(AI 出题、自己写、边写边被追问)。
  const [mode, setMode] = useState<PageMode>("drill");
  useEffect(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "drill" || saved === "mock") setMode(saved);
  }, []);
  function switchMode(next: PageMode) {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  }

  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "seed" | "generate">("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (): Promise<Problem[]> => {
    const r = await fetch("/api/job-hunter/interview/coding/problems");
    const j = await r.json();
    if (!j?.success) throw new Error(j?.error || "加载题库失败");
    setProblems(j.problems as Problem[]);
    return j.problems as Problem[];
  }, []);

  useEffect(() => {
    load().catch((e) => {
      setProblems([]);
      setError(e instanceof Error ? e.message : "加载题库失败");
    });
  }, [load]);

  const list = useMemo(
    () => (problems ?? []).filter((p) => !filter || p.category === filter),
    [problems, filter],
  );
  const active = useMemo(() => (problems ?? []).find((p) => p.id === activeId) ?? null, [problems, activeId]);

  // 分类角标:每类的题量 / 今天待练量(全部在客户端算,数据都在 problems 里)。
  const counts = useMemo(() => {
    const m = new Map<string, { total: number; due: number }>();
    for (const p of problems ?? []) {
      const cur = m.get(p.category) ?? { total: 0, due: 0 };
      cur.total += 1;
      if (p.isDue) cur.due += 1;
      m.set(p.category, cur);
    }
    return m;
  }, [problems]);
  const dueTotal = (problems ?? []).filter((p) => (!filter || p.category === filter) && p.isDue).length;

  /** 按遗忘曲线挑下一道:优先今天到期的(列表已按到期/记忆脆弱度排好),没有就顺着往下。 */
  function pickNext(after?: number): number | null {
    const pool = list.filter((p) => p.id !== after);
    return (pool.find((p) => p.isDue) ?? pool[0])?.id ?? null;
  }

  async function importSeed() {
    setBusy("seed");
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/job-hunter/interview/coding/seed", { method: "POST" });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "导入失败");
      await load();
      const en = j.filledEnglish > 0 ? `，顺带给 ${j.filledEnglish} 道老题补上了英文题干` : "";
      setNotice(j.added > 0 ? `导入了 ${j.added} 道经典题${en}。` : `经典题都已经在题库里了${en}。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy("");
    }
  }

  async function generate(opts: { categories: string[]; count: number; difficulty: string; focus: string }) {
    setBusy("generate");
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/job-hunter/interview/coding/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "出题失败");
      await load();
      setNotice(
        j.added > 0
          ? `新增 ${j.added} 道题${j.generated > j.added ? `(有 ${j.generated - j.added} 道和已有题重复,已跳过)` : ""}。`
          : "这次出的题都和已有题重复了,换个方向再试。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "出题失败");
    } finally {
      setBusy("");
    }
  }

  async function removeProblem(id: number) {
    if (!window.confirm("删掉这道题?成绩记录也会一起删除。")) return;
    try {
      const r = await fetch(`/api/job-hunter/interview/coding/problem?id=${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "删除失败");
      if (activeId === id) setActiveId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
        <Link href="/job-hunter/interview" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回面试复习中心
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600">
            {mode === "drill" ? "Coding 手感 · Type It Out" : "模拟面试 · Mock Interview"}
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {mode === "drill" ? "Coding 跟打训练" : "算法面试模拟"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {mode === "drill" ? (
              <>
                经典题目(Java Lambda / Stream、MySQL 标准 SQL、MongoDB 查询、程序设计，偶尔来道算法题)的参考答案会以
                <span className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-400">灰色</span>
                铺在输入区，你照着一个字一个字敲：敲对了变亮，敲错了不落字只记一次错，缩进自动补。
                敲完记手速和正确率，并按遗忘曲线安排下次再敲。
              </>
            ) : (
              <>
                AI 现出一道 LeetCode 式算法题，你在空白编辑器里自己写。写的过程中面试官会随时插话追问，
                问题用面试官的声音念出来 —— 你可以打字答，也可以直接说。交卷后 AI 复盘代码、复杂度和每个追问。
              </>
            )}
          </p>
          <div className="mt-4 inline-flex rounded-xl border border-slate-200 bg-white p-1">
            <button
              onClick={() => switchMode("drill")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "drill" ? "bg-indigo-600 text-white" : "text-slate-500 hover:text-indigo-600"
              }`}
            >
              ⌨️ 跟打模式
            </button>
            <button
              onClick={() => switchMode("mock")}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "mock" ? "bg-indigo-600 text-white" : "text-slate-500 hover:text-indigo-600"
              }`}
            >
              🎤 面试模式
            </button>
          </div>
        </header>

        {error && <p className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>}
        {notice && <p className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

        {mode === "mock" ? (
          <MockInterview />
        ) : active ? (
          <Trainer
            key={active.id}
            problem={active}
            onExit={() => setActiveId(null)}
            onNext={() => setActiveId(pickNext(active.id))}
            hasNext={pickNext(active.id) !== null}
            onSaved={load}
            onDelete={() => removeProblem(active.id)}
          />
        ) : (
          <div className="space-y-6">
            <Toolbar
              busy={busy}
              onSeed={importSeed}
              onGenerate={generate}
              defaultCategory={filter}
            />

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1.5">
                  <Chip
                    label="全部"
                    active={filter === ""}
                    due={(problems ?? []).filter((p) => p.isDue).length}
                    total={(problems ?? []).length}
                    onClick={() => setFilter("")}
                  />
                  {CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => (
                    <Chip
                      key={c}
                      label={CATEGORY_LABEL[c] ?? c}
                      active={filter === c}
                      due={counts.get(c)?.due ?? 0}
                      total={counts.get(c)?.total ?? 0}
                      onClick={() => setFilter(c)}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setActiveId(pickNext())}
                  disabled={!list.length}
                  className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  {dueTotal > 0 ? `开始今天的练习（${dueTotal} 道待敲）` : "随便敲一道 →"}
                </button>
              </div>

              {problems === null ? (
                <p className="mt-4 text-sm text-slate-400">正在加载题库……</p>
              ) : list.length === 0 ? (
                <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  题库还是空的。点上面「导入经典题库」马上开练，或者让 AI 出一批新题。
                </p>
              ) : (
                <div className="mt-4 space-y-2">
                  {list.map((p) => (
                    <ProblemRow key={p.id} p={p} onOpen={() => setActiveId(p.id)} onDelete={() => removeProblem(p.id)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/* ============================ 列表相关 ============================ */

function Chip({
  label,
  active,
  due,
  total,
  onClick,
}: {
  label: string;
  active: boolean;
  due: number;
  total: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active ? "bg-indigo-600 text-white" : "border border-slate-200 text-slate-600 hover:border-indigo-300"
      }`}
    >
      {label}
      <span className={active ? "ml-1 text-indigo-100" : "ml-1 text-slate-400"}>{total}</span>
      {due > 0 && <span className={active ? "ml-1 text-white" : "ml-1 text-rose-500"}>· {due} 待敲</span>}
    </button>
  );
}

function ProblemRow({ p, onOpen, onDelete }: { p: Problem; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3 transition hover:border-indigo-300 hover:bg-indigo-50/40">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
            {CATEGORY_LABEL[p.category] ?? p.category}
          </span>
          <span className="truncate font-medium text-slate-800">{p.title}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[p.state]}`}>
            {SR_STATE_LABEL[p.state]}
          </span>
          {p.isDue && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">待敲</span>}
        </div>
        <div className="mt-1 truncate text-xs text-slate-400">
          {DIFFICULTY_LABEL[p.difficulty] ?? "中等"} · {lineCount(p.solution)} 行
          {p.runs > 0 ? ` · 敲过 ${p.runs} 遍 · 最佳 ${p.bestWpm} wpm / ${p.bestAccuracy}%` : " · 还没敲过"}
          {" · "}
          {p.prompt}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <button onClick={onOpen} className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
          敲 →
        </button>
        <button onClick={onDelete} className="text-xs text-slate-300 hover:text-rose-500" title="删除这道题">
          ✕
        </button>
      </div>
    </div>
  );
}

/* ============================ 工具条:导入 / AI 出题 ============================ */

function Toolbar({
  busy,
  onSeed,
  onGenerate,
  defaultCategory,
}: {
  busy: "" | "seed" | "generate";
  onSeed: () => void;
  onGenerate: (opts: { categories: string[]; count: number; difficulty: string; focus: string }) => void;
  defaultCategory: string;
}) {
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<string[]>(defaultCategory ? [defaultCategory] : []);
  const [count, setCount] = useState(6);
  const [difficulty, setDifficulty] = useState("mixed");
  const [focus, setFocus] = useState("");

  const toggle = (c: string) => setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">题从哪来</p>
          <p className="mt-0.5 text-xs text-slate-400">
            内置经典题一键导入(去重，重复点不会多出副本)；想要更多就让 AI 按方向出。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={onSeed}
            disabled={!!busy}
            className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-50"
          >
            {busy === "seed" ? "导入中…" : "📚 导入经典题库"}
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={!!busy}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy === "generate" ? "AI 出题中…" : "✨ AI 出题"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-slate-500">出哪类(不选 = 混合，算法题只偶尔来一道)</p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_ORDER.map((c) => (
                <button
                  key={c}
                  onClick={() => toggle(c)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    cats.includes(c) ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              题数
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
              >
                {[3, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              难度
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
              >
                <option value="mixed">混合</option>
                <option value="easy">简单</option>
                <option value="medium">中等</option>
                <option value="hard">偏难</option>
              </select>
            </label>
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="想练的方向，如 Collectors 高级用法 / 窗口函数 / 聚合管道"
              className="min-w-[220px] flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onGenerate({ categories: cats, count, difficulty, focus })}
              disabled={!!busy}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy === "generate" ? "出题中…（一般 1 分钟内）" : "开始出题"}
            </button>
            <span className="text-xs text-slate-400">出好的题会自动入库，标题重复的自动跳过。</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================ 跟打训练器 ============================ */

function Trainer({
  problem,
  onExit,
  onNext,
  hasNext,
  onSaved,
  onDelete,
}: {
  problem: Problem;
  onExit: () => void;
  onNext: () => void;
  hasNext: boolean;
  onSaved: () => Promise<Problem[]>;
  onDelete: () => void;
}) {
  const target = useMemo(() => normalizeCode(problem.solution), [problem.solution]);

  const [typed, setTyped] = useState("");
  const [keystrokes, setKeystrokes] = useState(0);
  const [errors, setErrors] = useState(0);
  const [wrongAt, setWrongAt] = useState(0); // 敲错时闪一下(存时间戳,变了就重新闪)
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedMs, setFinishedMs] = useState<number | null>(null);
  const [, setTick] = useState(0); // 只为驱动计时器重渲染
  const [blind, setBlind] = useState(false);
  const [peek, setPeek] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ grade: RecallGrade; nextLabel: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);

  // 加入猛攻题库:把这道题变成一张复习卡,进「按简历死磕」的遗忘曲线队列。
  const [cramSessions, setCramSessions] = useState<CramSummary[] | null>(null);
  const [pickingCram, setPickingCram] = useState(false);
  const [cramBusy, setCramBusy] = useState(false);
  const [cramNotice, setCramNotice] = useState("");

  // 断点拆解:每一步返回什么(类型 + 示例值);选中某一步就在上面的代码里高亮对应片段。
  const [showTrace, setShowTrace] = useState(false);
  const [trace, setTrace] = useState<CodingTrace | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState("");
  const [activeStep, setActiveStep] = useState<number | null>(null);

  // IDE 模式:敲开括号就把配对的闭括号自动补上(和 IntelliJ / VS Code 一个手感)。
  const [ideMode, setIdeMode] = useState(true);
  useEffect(() => {
    setIdeMode(localStorage.getItem(IDE_MODE_KEY) !== "0");
  }, []);
  const closedRef = useRef<Set<number>>(new Set()); // 已经自动补过的位置(目标代码下标)
  const [, setClosedTick] = useState(0); // 集合是可变对象,改了要手动触发重渲染

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const done = typed.length >= target.length && target.length > 0;

  // 计时:第一次敲下有效字符才开始,敲完停表。
  useEffect(() => {
    if (startedAt === null || finishedMs !== null) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [startedAt, finishedMs]);

  useEffect(() => {
    if (done && startedAt !== null && finishedMs === null) setFinishedMs(Date.now() - startedAt);
  }, [done, startedAt, finishedMs]);

  // 光标永远跟在已敲内容末尾(值是我们自己控制的,不能让浏览器乱放)。
  useEffect(() => {
    const el = areaRef.current;
    if (el && document.activeElement === el) el.setSelectionRange(typed.length, typed.length);
  }, [typed]);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  // 敲错闪红 200ms
  useEffect(() => {
    if (!wrongAt) return;
    const t = window.setTimeout(() => setWrongAt(0), 200);
    return () => window.clearTimeout(t);
  }, [wrongAt]);

  useEffect(() => {
    fetch(`/api/job-hunter/interview/coding/problem?id=${problem.id}`)
      .then((r) => r.json())
      .then((j) => setAttempts(j?.success ? (j.attempts as Attempt[]) : []))
      .catch(() => setAttempts([]));
  }, [problem.id]);

  const elapsedMs = finishedMs ?? (startedAt === null ? 0 : Date.now() - startedAt);
  const wpm = calcWpm(keystrokes, elapsedMs);
  const accuracy = calcAccuracy(keystrokes, errors);
  const progress = target.length ? Math.round((typed.length / target.length) * 100) : 0;

  function accept(chunk: string, keys: number) {
    if (startedAt === null) setStartedAt(Date.now());
    if (chunk) setTyped((prev) => prev + chunk);
    if (keys > 0) setKeystrokes((n) => n + keys);
  }

  /**
   * 输入统一走 input 事件(而不是只听 keydown):普通打字、听写、输入法、自动补全都会走这里。
   * 已敲内容永远是目标代码的前缀,所以「新增的那段」就是 value 里多出来的尾巴。
   * 敲错时不改 typed,只 +1 错误数 —— 这次 setState 会让 React 把 DOM 里那个错字撤回。
   */
  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    if (next.length <= typed.length) {
      setTyped(next); // 退格/删除:仍然是前缀,直接接受
      dropClosedFrom(closedRef.current, next.length); // 退回去的自动补标记作废,重敲开括号会重新补
      setClosedTick((n) => n + 1);
      return;
    }
    if (done) return;
    const chunk = next.slice(typed.length);
    const out = ideMode
      ? applyInputIde(target, typed.length, chunk, closedRef.current)
      : applyInput(target, typed.length, chunk);
    if (ideMode) setClosedTick((n) => n + 1);
    accept(out.accept, out.consumed);
    if (out.error) {
      setErrors((n) => n + 1);
      setWrongAt(Date.now());
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // 让 Cmd+R / Cmd+A 之类照常走
    if (e.key === "Tab") {
      // Tab 默认会跳走焦点;这里改成「把当前位置的缩进一次补完」。
      e.preventDefault();
      if (done) return;
      const skip = tabSkip(target, typed.length);
      if (skip) accept(skip, 1);
      return;
    }
    // 不让光标离开末尾(否则插入位置就不是「下一个该敲的字」了)
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key === "Delete") e.preventDefault();
  }

  /** 点到中间也把光标弹回末尾 */
  function onSelect(e: SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (el.selectionStart !== typed.length || el.selectionEnd !== typed.length) {
      el.setSelectionRange(typed.length, typed.length);
    }
  }

  function restart() {
    setTyped("");
    setKeystrokes(0);
    setErrors(0);
    setStartedAt(null);
    setFinishedMs(null);
    setSaved(null);
    setSaveError("");
    closedRef.current = new Set();
    setClosedTick((n) => n + 1);
    areaRef.current?.focus();
  }

  async function rate(grade: RecallGrade) {
    setSaving(true);
    setSaveError("");
    try {
      const r = await fetch("/api/job-hunter/interview/coding/attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problemId: problem.id,
          wpm,
          accuracy,
          durationSec: Math.round(elapsedMs / 1000),
          keystrokes,
          errors,
          mode: blind ? "blind" : "ghost",
          grade,
        }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "保存成绩失败");
      setSaved({ grade, nextLabel: j.nextReviewLabel as string });
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存成绩失败");
    } finally {
      setSaving(false);
    }
  }

  const ghostHidden = blind && !peek;
  const suggestion = suggestGrade(accuracy, wpm);

  /** 拉一次猛攻版的简历列表(加入题库要选目标) */
  async function loadCramSessions(): Promise<CramSummary[]> {
    const r = await fetch("/api/job-hunter/interview/cram/sessions");
    const j = await r.json();
    const list = (j?.success ? (j.sessions as CramSummary[]) : []) ?? [];
    setCramSessions(list);
    return list;
  }

  /** 点「加入猛攻」:记得上次选的就直接加,否则先让你挑一份简历。 */
  async function addToCram(sessionId?: number) {
    setCramNotice("");
    let target = sessionId;
    if (!target) {
      const saved = Number(localStorage.getItem(CRAM_SESSION_KEY));
      const list = cramSessions ?? (await loadCramSessions());
      if (!list.length) {
        setCramNotice("还没有猛攻版的简历，先去「对应简历猛攻版」上传一份。");
        return;
      }
      if (list.length === 1) target = list[0].id;
      else if (saved && list.some((x) => x.id === saved)) target = saved;
      else {
        setPickingCram(true);
        return;
      }
    }
    setCramBusy(true);
    setPickingCram(false);
    try {
      const r = await fetch("/api/job-hunter/interview/coding/to-cram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId: problem.id, sessionId: target }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "加入失败");
      localStorage.setItem(CRAM_SESSION_KEY, String(target));
      setCramNotice(
        j.duplicate
          ? `这道题已经在《${j.sessionTitle}》的复习队列里了。`
          : `已加入《${j.sessionTitle}》的复习队列，今天就会排到。`,
      );
    } catch (e) {
      setCramNotice(e instanceof Error ? e.message : "加入失败");
    } finally {
      setCramBusy(false);
    }
  }

  async function loadTrace(regenerate = false) {
    setTracing(true);
    setTraceError("");
    try {
      const r = await fetch("/api/job-hunter/interview/coding/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId: problem.id, regenerate }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "拆解失败");
      setTrace(j.trace as CodingTrace);
      setActiveStep(null);
    } catch (e) {
      setTraceError(e instanceof Error ? e.message : "拆解失败");
    } finally {
      setTracing(false);
    }
  }

  // 选中的那一步在参考代码里的位置(片段是原样复制的,找得到就能高亮;找不到就只显示文字)。
  const highlight = useMemo(() => {
    if (activeStep === null || !trace) return null;
    return findSnippet(target, trace.steps[activeStep]?.snippet ?? "");
  }, [activeStep, trace, target]);

  return (
    <div className="space-y-4">
      {/* 头部:标题 + 状态 + 操作 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                {CATEGORY_LABEL[problem.category] ?? problem.category}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[problem.state]}`}>
                {SR_STATE_LABEL[problem.state]}
              </span>
              <span className="text-[11px] text-slate-400">
                {DIFFICULTY_LABEL[problem.difficulty] ?? "中等"} · {lineCount(target)} 行 ·{" "}
                {problem.runs > 0 ? `最佳 ${problem.bestWpm} wpm / ${problem.bestAccuracy}%` : "首次"}
              </span>
            </div>
            <h2 className="mt-2 text-lg font-bold text-slate-900">{problem.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{problem.prompt}</p>
            {problem.promptEn && (
              <p className="mt-1 text-sm italic leading-relaxed text-slate-400">{problem.promptEn}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void addToCram()}
              disabled={cramBusy}
              title="把这道题变成一张复习卡，加进「按简历死磕」的遗忘曲线队列（会被自动念题，练张嘴说得出来）"
              className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-50"
            >
              {cramBusy ? "加入中…" : "➕ 加入猛攻"}
            </button>
            <button onClick={onExit} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
              ← 题库
            </button>
            <button
              onClick={() => setEditing((v) => !v)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              title="参考代码有错就改这里"
            >
              ✎ 改题
            </button>
            <button onClick={onDelete} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-400 hover:text-rose-500">
              ✕
            </button>
          </div>
        </div>

        {cramNotice && (
          <p className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {cramNotice}
            <button
              onClick={() => {
                setCramNotice("");
                void loadCramSessions().then(() => setPickingCram(true));
              }}
              className="text-emerald-600 underline hover:text-emerald-800"
            >
              换一份简历
            </button>
          </p>
        )}

        {pickingCram && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
            <p className="text-xs font-medium text-slate-600">加进哪份简历的复习队列？</p>
            <div className="mt-2 space-y-1.5">
              {(cramSessions ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => void addToCram(c.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs transition hover:border-emerald-300 hover:bg-emerald-50"
                >
                  <span className="min-w-0 truncate text-slate-700">{c.title}</span>
                  <span className="shrink-0 text-slate-400">{c.total} 张</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setPickingCram(false)}
              className="mt-2 text-xs text-slate-400 hover:text-slate-600"
            >
              取消
            </button>
          </div>
        )}

        {problem.setup && (
          <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 px-4 py-3 font-mono text-xs leading-relaxed text-slate-500">
            {problem.setup}
          </pre>
        )}
      </div>

      {editing && (
        <EditPanel
          problem={problem}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onSaved();
            restart();
          }}
        />
      )}

      {/* 跟打区 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>
              进度 <b className="text-slate-800">{progress}%</b>
            </span>
            <span>
              手速 <b className="text-slate-800">{wpm}</b> wpm
            </span>
            <span>
              正确率 <b className={accuracy >= 95 ? "text-emerald-600" : accuracy >= 85 ? "text-amber-600" : "text-rose-600"}>{accuracy}%</b>
            </span>
            <span>
              错 <b className="text-slate-800">{errors}</b>
            </span>
            <span>{durationLabel(elapsedMs)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setBlind((v) => !v);
                setPeek(false);
                areaRef.current?.focus();
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                blind ? "bg-slate-800 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
              title="盲打:把灰色答案藏起来,自己回忆着敲"
            >
              {blind ? "盲打中" : "灰字跟打"}
            </button>
            {blind && (
              <button
                onMouseDown={() => setPeek(true)}
                onMouseUp={() => setPeek(false)}
                onMouseLeave={() => setPeek(false)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
              >
                按住看一眼
              </button>
            )}
            <button
              onClick={() => {
                const next = !ideMode;
                setIdeMode(next);
                localStorage.setItem(IDE_MODE_KEY, next ? "1" : "0");
                closedRef.current = new Set();
                setClosedTick((n) => n + 1);
              }}
              title="像 IDE 一样:敲下 ( [ { < 或引号,配对的闭括号自动补上,你只管往里填。关掉就是老老实实逐字敲。"
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                ideMode
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              IDE 模式
            </button>
            <button
              onClick={restart}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              重来
            </button>
          </div>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${progress}%` }} />
        </div>

        <div
          onClick={() => areaRef.current?.focus()}
          className={`relative mt-3 cursor-text overflow-hidden rounded-xl border-2 bg-slate-900 transition-colors ${
            wrongAt ? "border-rose-500" : "border-slate-800"
          }`}
        >
          <pre
            aria-hidden
            className="pointer-events-none m-0 whitespace-pre-wrap break-words px-4 py-4 font-mono text-[13px] leading-6 tracking-normal"
          >
            {/* 已敲=亮绿,未敲=灰(盲打时透明);选中某一步时,它对应的片段整段高亮。 */}
            {codeSegments(target, typed.length, highlight, ideMode ? closedRef.current : undefined).map((seg) => (
              <span
                key={seg.start}
                className={[
                  seg.isTyped ? "text-emerald-300" : ghostHidden ? "select-none text-transparent" : "select-none text-slate-500",
                  // IDE 已经帮你补好的闭括号:提前点亮成暗绿,提示「这个不用你敲」。
                  seg.isAuto && !seg.isTyped && !ghostHidden ? "!text-emerald-700" : "",
                  seg.isHighlight ? "rounded-sm bg-indigo-500/30" : "",
                  seg.isHighlight && !seg.isTyped && !ghostHidden ? "!text-indigo-200" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {target.slice(seg.start, seg.end)}
              </span>
            ))}
            {/* 末尾垫一行,保证光标在最后一行也有落脚点 */}
            {"\n"}
          </pre>
          <textarea
            ref={areaRef}
            value={typed}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            onPaste={(e) => e.preventDefault()}
            onDrop={(e) => e.preventDefault()}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            className="absolute inset-0 h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent px-4 py-4 font-mono text-[13px] leading-6 tracking-normal text-transparent caret-emerald-400 outline-none"
          />
        </div>

        <p className="mt-2 text-xs text-slate-400">
          敲错不会落字，只记一次错；回车会自动补下一行缩进；粘贴已禁用（练的就是手感）。
          {ideMode
            ? " IDE 模式：敲下 ( [ { < 或引号，配对的那半边自动补上（暗绿色 = 已经帮你补好，跳过不用敲；习惯性再敲一遍也不算错）。"
            : " 当前是逐字模式：闭括号要自己敲。"}
        </p>

        {/* 断点:每一步返回什么(类型 + 示例值) */}
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                const next = !showTrace;
                setShowTrace(next);
                if (next && !trace && !tracing) void loadTrace();
                if (!next) setActiveStep(null);
              }}
              className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
            >
              {showTrace ? "收起断点" : "🔬 每一步返回什么（断点）"}
            </button>
            {showTrace && trace && (
              <button
                onClick={() => void loadTrace(true)}
                disabled={tracing}
                className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
              >
                重新拆
              </button>
            )}
            {showTrace && <span className="text-xs text-slate-400">点某一步 → 上面代码里高亮对应片段</span>}
          </div>

          {showTrace && (
            <div className="mt-3">
              {tracing && <p className="text-sm text-slate-400">正在按求值顺序拆解……（只算一次，之后都从缓存取）</p>}
              {traceError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{traceError}</p>}
              {trace && (
                <>
                  {trace.sampleInput && (
                    <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-medium text-slate-400">示例输入（下面的值都按它算）</p>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-slate-600">
                        {trace.sampleInput}
                      </pre>
                    </div>
                  )}
                  <ol className="space-y-1.5">
                    {trace.steps.map((s, i) => {
                      const active = activeStep === i;
                      return (
                        <li key={i}>
                          <button
                            onClick={() => setActiveStep(active ? null : i)}
                            className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                              active
                                ? "border-indigo-300 bg-indigo-50/70"
                                : "border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50"
                            }`}
                          >
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-[11px] font-semibold text-slate-400">{i + 1}</span>
                              <code className="min-w-0 break-all font-mono text-xs text-slate-700">{s.snippet}</code>
                              <span className="text-slate-300">→</span>
                              <code className="break-all rounded bg-violet-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-violet-700">
                                {s.type}
                              </code>
                            </div>
                            {s.value && (
                              <div className="mt-1 break-all font-mono text-xs text-emerald-700">= {s.value}</div>
                            )}
                            {s.note && <div className="mt-1 text-xs leading-relaxed text-slate-500">{s.note}</div>}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 敲完:成绩 + 自评 */}
      {done && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm">
          <p className="text-sm font-semibold text-emerald-800">敲完了 🎉</p>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-700">
            <span>
              用时 <b>{durationLabel(elapsedMs)}</b>
            </span>
            <span>
              手速 <b>{wpm}</b> wpm
            </span>
            <span>
              正确率 <b>{accuracy}%</b>
            </span>
            <span>
              敲错 <b>{errors}</b> 次
            </span>
            {problem.bestWpm > 0 && (
              <span className={wpm > problem.bestWpm ? "font-semibold text-emerald-700" : "text-slate-400"}>
                {wpm > problem.bestWpm ? `破纪录！之前最佳 ${problem.bestWpm} wpm` : `历史最佳 ${problem.bestWpm} wpm`}
              </span>
            )}
          </div>

          {saveError && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{saveError}</p>}

          {saved ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-emerald-700">
                已记下：{GRADE_LABEL[saved.grade]} · 下次安排在 <b>{saved.nextLabel}</b>
              </p>
              <button
                onClick={restart}
                className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                再敲一遍
              </button>
              {hasNext && (
                <button
                  onClick={onNext}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  下一题 →
                </button>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <p className="mb-2 text-xs text-slate-500">这遍敲下来手感如何？（决定下次什么时候再敲）</p>
              <div className="flex flex-wrap gap-2">
                {(["forgot", "vague", "clear"] as RecallGrade[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => rate(g)}
                    disabled={saving}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
                      g === suggestion
                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {GRADE_LABEL[g]}
                    {g === suggestion && <span className="ml-1 text-[11px] text-emerald-100">建议</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 讲解 + 历史成绩 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={() => setShowExplain((v) => !v)}
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            {showExplain ? "收起讲解" : "💡 看讲解 / 考点"}
          </button>
          {attempts && attempts.length > 0 && (
            <p className="text-xs text-slate-400">
              最近成绩：
              {attempts
                .slice(0, 5)
                .map((a) => `${a.wpm}wpm/${a.accuracy}%`)
                .join(" · ")}
            </p>
          )}
        </div>
        {showExplain && (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
            {problem.explanation || "这道题还没有讲解。"}
          </p>
        )}
      </div>
    </div>
  );
}

/* ============================ 改题 ============================ */

function EditPanel({
  problem,
  onClose,
  onSaved,
}: {
  problem: Problem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(problem.title);
  const [prompt, setPrompt] = useState(problem.prompt);
  const [promptEn, setPromptEn] = useState(problem.promptEn);
  const [setup, setSetup] = useState(problem.setup);
  const [solution, setSolution] = useState(problem.solution);
  const [explanation, setExplanation] = useState(problem.explanation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/job-hunter/interview/coding/problem", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: problem.id, title, prompt, promptEn, setup, solution, explanation }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || "保存失败");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm";
  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
      <p className="text-sm font-semibold text-amber-800">改题(参考代码不对就在这儿改，改完不影响已有进度)</p>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p>}
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="标题" />
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} className={field} placeholder="题干（中文）" />
      <textarea
        value={promptEn}
        onChange={(e) => setPromptEn(e.target.value)}
        rows={2}
        className={field}
        placeholder="题干（English）"
      />
      <textarea
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
        rows={2}
        className={`${field} font-mono text-xs`}
        placeholder="给定上下文(表结构 / 集合结构 / 类签名)"
      />
      <textarea
        value={solution}
        onChange={(e) => setSolution(e.target.value)}
        rows={10}
        className={`${field} font-mono text-xs`}
        placeholder="参考代码(会被逐字敲出来)"
      />
      <textarea
        value={explanation}
        onChange={(e) => setExplanation(e.target.value)}
        rows={2}
        className={field}
        placeholder="讲解 / 考点"
      />
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
          取消
        </button>
      </div>
    </div>
  );
}
