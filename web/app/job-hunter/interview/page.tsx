"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type QuestionType = "concept" | "scenario" | "system-design" | "behavioral";

type Skill = {
  id: number;
  name: string;
  category: string;
  importance: number;
  mastery: number;
  attempts: number;
};

type AnswerSummary = {
  id: number;
  skill: string;
  type: QuestionType;
  prompt: string;
  total: number;
  created_at: string;
};

type SrState = "new" | "learning" | "young" | "mastered";

type SrCounts = { total: number; fresh: number; due: number; later: number; mastered: number };

type BankItem = {
  id: number;
  skillId: number;
  skill: string;
  category: string;
  type: QuestionType;
  prompt: string;
  state: SrState;
  isDue: boolean;
  lastScore: number | null;
  intervalDays: number;
  dueAt: string | null;
  lastReviewedAt: string | null;
  source: string;
};

type Progress = {
  session: { id: number; language: string; mode?: string; title?: string };
  skills: Skill[];
  recentAnswers: AnswerSummary[];
  srCounts?: SrCounts;
  bank?: BankItem[];
};

type CurrentQuestion = {
  questionId: number;
  skill: { id: number; name: string; category: string };
  type: QuestionType;
  prompt: string;
  srState?: SrState;
};

type BiText = { zh: string; en: string };

type Grade = {
  total: number;
  criteria: Array<{ criterion: string; score: number; comment: string; commentEn: string }>;
  hits: BiText[];
  misses: BiText[];
  errors: BiText[];
  advice: BiText[];
};

type ReviewInfo = {
  intervalDays: number;
  nextReviewLabel: string;
  state: SrState;
  passed: boolean;
};

type GradeResult = { grade: Grade; mastery: number; referenceAnswer: string; review?: ReviewInfo };

type KbDoc = { id: number; title: string; char_count: number; chunk_count: number };

const TYPE_LABEL: Record<QuestionType, string> = {
  concept: "概念题",
  scenario: "场景题",
  "system-design": "系统设计",
  behavioral: "行为面试",
};

const SR_STATE_LABEL: Record<SrState, string> = {
  new: "新题",
  learning: "学习中",
  young: "巩固中",
  mastered: "已掌握",
};

const SR_STATE_CLASS: Record<SrState, string> = {
  new: "bg-sky-50 text-sky-600",
  learning: "bg-amber-50 text-amber-700",
  young: "bg-violet-50 text-violet-700",
  mastered: "bg-emerald-50 text-emerald-700",
};

function masteryColor(m: number): string {
  if (m < 40) return "bg-rose-500";
  if (m < 70) return "bg-amber-500";
  return "bg-emerald-500";
}

type BankSummary = {
  id: number;
  title: string;
  language: string;
  created_at: string;
  total: number;
  due: number;
};

/**
 * 播放一段 TTS 音频:每次用全新的 Audio 元素,等缓冲到「可完整播放」再从头(currentTime=0)播。
 * 直接 `a.src=url; a.play()`(尤其复用同一个元素)常导致开头被吃掉、只听到后半段。
 * ref 保存当前音频,便于停止/卸载清理;onEnded 用于调用方复位播放状态。
 */
function playTts(blob: Blob, ref: { current: HTMLAudioElement | null }, onEnded?: () => void) {
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
    a.currentTime = 0; // 关键:从头播,避免只听到后半段
    a.play().catch(() => {});
  };
  // canplay / loadeddata 都表示已就绪可从当前位置播;取先触发者(canplaythrough 对
  // 短 blob 音频不稳定,故不依赖它)。currentTime=0 保证从开头播。
  a.addEventListener("canplay", start, { once: true });
  a.addEventListener("loadeddata", start, { once: true });
  a.addEventListener(
    "ended",
    () => {
      URL.revokeObjectURL(url);
      onEnded?.();
    },
    { once: true },
  );
  a.load();
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) return { ok: false, data: null, error: json?.error || "请求失败" };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, data: null, error: "网络异常" };
  }
}

export default function InterviewPage() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(true);
  const [progressError, setProgressError] = useState<string | null>(null);

  const [question, setQuestion] = useState<CurrentQuestion | null>(null);
  const [fetchingQuestion, setFetchingQuestion] = useState(false);
  const [answer, setAnswer] = useState("");
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [practiceError, setPracticeError] = useState<string | null>(null);

  // 讲解卡的目标:skill=技能层面补强(/coach);question=某一道题的讲解(/explain,点「不会」用)。
  const [coachTarget, setCoachTarget] = useState<{ kind: "skill" | "question"; id: number } | null>(null);
  const [coach, setCoach] = useState<{ lesson: string; modelAnswer: string; practiceQuestion: string } | null>(null);
  const [coachPrompt, setCoachPrompt] = useState<string | null>(null); // 单题讲解时:题干
  const [coaching, setCoaching] = useState(false);
  const [coachCached, setCoachCached] = useState(false);
  const [coachSr, setCoachSr] = useState<{
    lastPct: number | null;
    reviewed: boolean;
    nextReviewLabel: string | null;
  } | null>(null);
  const [coachCardsKey, setCoachCardsKey] = useState(0); // bump 以刷新「讲解复习」面板

  const [reviewExhausted, setReviewExhausted] = useState(false);

  const [banks, setBanks] = useState<BankSummary[] | null>(null);

  const practiceRef = useRef<HTMLDivElement | null>(null);
  const coachRef = useRef<HTMLDivElement | null>(null);
  const isBank = progress?.session.mode === "bank";

  // 从 URL 读取 session（纯客户端，避免 useSearchParams 的 Suspense 约束）
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = Number(sp.get("session"));
    setSessionId(Number.isInteger(id) && id > 0 ? id : null);
  }, []);

  const loadProgress = useCallback(async (id: number) => {
    setLoadingProgress(true);
    setProgressError(null);
    try {
      const res = await fetch(`/api/job-hunter/interview/progress?sessionId=${id}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setProgressError(json?.error || "加载训练进度失败");
        return;
      }
      setProgress(json as Progress);
    } catch {
      setProgressError("网络异常,无法加载进度");
    } finally {
      setLoadingProgress(false);
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      loadProgress(sessionId);
      return;
    }
    // 没有指定 session → 复习中心:列出所有题库(按人名)供选择。
    setLoadingProgress(false);
    (async () => {
      try {
        const res = await fetch("/api/job-hunter/interview/banks");
        const json = await res.json().catch(() => null);
        setBanks(json?.success ? (json.banks as BankSummary[]) : []);
      } catch {
        setBanks([]);
      }
    })();
  }, [sessionId, loadProgress]);

  async function nextQuestion(skillId?: number) {
    if (!sessionId) return;
    setPracticeError(null);
    setGrade(null);
    setAnswer("");
    setReviewExhausted(false);
    setFetchingQuestion(true);
    const { ok, data, error } = await postJson<CurrentQuestion & { success: boolean }>(
      "/api/job-hunter/interview/question",
      { sessionId, skillId },
    );
    setFetchingQuestion(false);
    if (!ok || !data) {
      setPracticeError(error ?? "出题失败");
      return;
    }
    setQuestion(data);
    setTimeout(() => practiceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  // 间隔重复复习:向 /next 要下一张到期/新题(不烧 AI,直接从题库取)。
  async function startReview() {
    if (!sessionId) return;
    setPracticeError(null);
    setGrade(null);
    setAnswer("");
    setReviewExhausted(false);
    setFetchingQuestion(true);
    try {
      const res = await fetch(`/api/job-hunter/interview/next?sessionId=${sessionId}`);
      const json = await res.json().catch(() => null);
      setFetchingQuestion(false);
      if (!res.ok || !json?.success) {
        setPracticeError(json?.error || "获取复习题失败");
        return;
      }
      if (!json.card) {
        setReviewExhausted(true);
        setQuestion(null);
        return;
      }
      setQuestion(json.card as CurrentQuestion);
      setTimeout(() => practiceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch {
      setFetchingQuestion(false);
      setPracticeError("网络异常,无法获取复习题");
    }
  }

  // 从题库列表直接练某一道(题干已在列表里,无需再取)。
  function practiceBankItem(item: BankItem) {
    setPracticeError(null);
    setGrade(null);
    setAnswer("");
    setReviewExhausted(false);
    setQuestion({
      questionId: item.id,
      skill: { id: item.skillId, name: item.skill, category: item.category },
      type: item.type,
      prompt: item.prompt,
      srState: item.state,
    });
    setTimeout(() => practiceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function submitAnswer() {
    if (!question || !answer.trim()) {
      setPracticeError("请先作答再提交。");
      return;
    }
    setPracticeError(null);
    setGrading(true);
    const { ok, data, error } = await postJson<GradeResult & { success: boolean }>(
      "/api/job-hunter/interview/answer",
      { questionId: question.questionId, answer },
    );
    setGrading(false);
    if (!ok || !data) {
      setPracticeError(error ?? "评分失败");
      return;
    }
    setGrade(data);
    if (sessionId) loadProgress(sessionId);
  }

  type CoachResp = {
    coach: typeof coach;
    success: boolean;
    cached?: boolean;
    prompt?: string;
    sr?: { lastPct: number | null; reviewed: boolean; nextReviewLabel: string | null };
  };

  async function openCoachCard(
    target: { kind: "skill" | "question"; id: number },
    url: string,
    body: Record<string, unknown>,
    failMsg: string,
  ) {
    setCoachTarget(target);
    setCoach(null);
    setCoachPrompt(null);
    setCoachSr(null);
    setCoaching(true);
    setTimeout(() => coachRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    const { ok, data, error } = await postJson<CoachResp>(url, body);
    setCoaching(false);
    if (ok && data?.coach) {
      setCoach(data.coach);
      setCoachCached(!!data.cached);
      setCoachPrompt(data.prompt ?? null);
      setCoachSr(data.sr ?? null);
    } else setProgressError(error ?? failMsg);
  }

  // 技能层面的补强(能力项面板「补强」)。
  function requestCoach(skillId: number, regenerate = false) {
    if (!sessionId) return;
    if (!Number.isInteger(skillId) || skillId <= 0) {
      setProgressError("暂时无法定位技能。");
      return;
    }
    return openCoachCard(
      { kind: "skill", id: skillId },
      "/api/job-hunter/interview/coach",
      { sessionId, skillId, regenerate },
      "生成补强内容失败",
    );
  }

  // 某一道题的讲解(答题卡「不会」/ 讲解复习面板)。绑定 questionId,每题各有各的讲解。
  function requestExplain(questionId: number, regenerate = false) {
    if (!sessionId) return;
    if (!Number.isInteger(questionId) || questionId <= 0) {
      setProgressError("这道题暂时无法定位,请从「开始复习」进入后再看讲解。");
      return;
    }
    return openCoachCard(
      { kind: "question", id: questionId },
      "/api/job-hunter/interview/explain",
      { questionId, regenerate },
      "生成讲解失败",
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href={sessionId ? "/job-hunter" : "/"} className="text-sm text-slate-400 hover:text-slate-600">
          {sessionId ? "← 返回求职神器" : "← 返回工具箱"}
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-600">
            {!sessionId ? "面试复习 · Interview Review" : isBank ? "简历面试题库 · Interview Bank" : "专项面试训练 · Interview Prep"}
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {!sessionId ? "面试复习中心" : isBank ? "按你的简历刷面试题" : "针对这份 JD 练到会"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {!sessionId
              ? "选一份题库开始按遗忘曲线复习（按人名 / 简历区分），或复习你的单词本。所有题库和进度都存在数据库里，随时回来接着练。"
              : isBank
                ? "我当面试官、按你简历里的技能与项目出题（以概念 / 场景 / 系统设计等技术题为主，少量行为面试）；你打字作答，AI 评分并给参考答案，每道题按遗忘曲线自动安排下次复习。进度自动保存。"
                : "按岗位技能出题、打字作答、AI 评分定位弱点，自适应优先练你最薄弱的部分。进度自动保存。"}
          </p>
          {isBank && progress?.session.title && (
            <p className="mt-1 text-xs text-slate-400">题库绑定简历：{progress.session.title}</p>
          )}
        </header>

        {/* 复习中心(无 session):列出所有题库供选择 + 单词本 */}
        {!sessionId && (
          <div className="space-y-6">
            <BankPicker banks={banks} />
            <VocabManager />
          </div>
        )}

        {progressError && (
          <p className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{progressError}</p>
        )}

        {loadingProgress && sessionId && <p className="text-sm text-slate-400">正在加载训练进度……</p>}

        {progress && (
          <div className="space-y-6">
            {/* 复习面板(题库模式):遗忘曲线的今日到期 / 新题 / 已掌握 */}
            {isBank && progress.srCounts && (
              <ReviewDashboard
                counts={progress.srCounts}
                busy={fetchingQuestion || grading}
                exhausted={reviewExhausted}
                hasQuestion={!!question}
                onStart={startReview}
              />
            )}

            {isBank && sessionId && (
              <FundamentalsPanel
                sessionId={sessionId}
                count={(progress.bank ?? []).filter((b) => b.source === "fundamentals").length}
                onDone={() => loadProgress(sessionId)}
              />
            )}

            {isBank && sessionId && (
              <CoachReviewPanel
                key={coachCardsKey}
                sessionId={sessionId}
                onOpen={(qid) => requestExplain(qid)}
              />
            )}

            <SkillPanel
              skills={progress.skills}
              onPractice={(id) => nextQuestion(id)}
              onCoach={requestCoach}
              busy={fetchingQuestion}
              title={isBank ? "能力项掌握度" : "技能掌握度"}
              showPractice={!isBank}
            />

            <div className="flex flex-wrap items-center gap-3">
              {!isBank && (
                <button
                  onClick={() => nextQuestion()}
                  disabled={fetchingQuestion || grading}
                  className="rounded-xl bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
                >
                  {fetchingQuestion ? "正在出题…" : question ? "换一题（练最弱）" : "开始练习（练最弱）"}
                </button>
              )}
              <KbManager />
              <VocabManager />
            </div>

            {/* 讲解卡(技能补强 / 单题讲解) */}
            <div ref={coachRef}>
              {coachTarget !== null && (
                <CoachCard
                  loading={coaching}
                  coach={coach}
                  cached={coachCached}
                  sessionId={sessionId ?? 0}
                  kind={coachTarget.kind}
                  targetId={coachTarget.id}
                  promptText={coachPrompt}
                  sr={coachSr}
                  onRated={() => setCoachCardsKey((k) => k + 1)}
                  onClose={() => {
                    setCoachTarget(null);
                    setCoach(null);
                  }}
                  onRegenerate={() => {
                    if (!coachTarget) return;
                    if (coachTarget.kind === "question") requestExplain(coachTarget.id, true);
                    else requestCoach(coachTarget.id, true);
                  }}
                />
              )}
            </div>

            {/* 答题区 */}
            <div ref={practiceRef}>
              {question && (
                <PracticeCard
                  question={question}
                  answer={answer}
                  setAnswer={setAnswer}
                  grading={grading}
                  grade={grade}
                  error={practiceError}
                  onSubmit={submitAnswer}
                  onNext={isBank ? startReview : () => nextQuestion()}
                  nextLabel={isBank ? "下一张（复习）→" : "下一题 →"}
                  onExplain={() => requestExplain(question.questionId)}
                />
              )}
            </div>

            {/* 题库列表(题库模式) */}
            {isBank && progress.bank && progress.bank.length > 0 && (
              <BankPanel items={progress.bank} onPractice={practiceBankItem} busy={fetchingQuestion || grading} />
            )}

            {progress.recentAnswers.length > 0 && (
              <HistoryPanel answers={progress.recentAnswers} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function SkillPanel({
  skills,
  onPractice,
  onCoach,
  busy,
  title = "技能掌握度",
  showPractice = true,
}: {
  skills: Skill[];
  onPractice: (id: number) => void;
  onCoach: (id: number) => void;
  busy: boolean;
  title?: string;
  showPractice?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      <div className="mt-3 space-y-3">
        {skills.map((s) => (
          <div key={s.id}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-slate-700">
                {s.name}
                <span className="ml-2 text-xs text-slate-400">{s.category}</span>
              </span>
              <span className="text-xs text-slate-400">
                {s.attempts > 0 ? `${Math.round(s.mastery)}分 · ${s.attempts}次` : "未练"}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${masteryColor(s.mastery)}`}
                  style={{ width: `${Math.max(3, Math.round(s.mastery))}%` }}
                />
              </div>
              {showPractice && (
                <button
                  onClick={() => onPractice(s.id)}
                  disabled={busy}
                  className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-cyan-300 hover:text-cyan-700 disabled:opacity-50"
                >
                  练这个
                </button>
              )}
              <button
                onClick={() => onCoach(s.id)}
                className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-cyan-300 hover:text-cyan-700"
              >
                补强
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 可划词翻译的英文文本块:选中一个词/短语 → 浮层显示其中文释义(结合上下文,OpenAI)。
 * 用于只读英文(题干、参考答案),帮助英文面试备考时随手查词。
 */
function TranslatableText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pop, setPop] = useState<{ x: number; y: number; term: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<{ en: string; ipa: string; zh: string; note: string } | null>(null);
  const reqIdRef = useRef(0);
  // 发音:复用 /speak(OpenAI TTS)读出选中的词
  const termAudioRef = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  // 加入单词本
  const [vocab, setVocab] = useState<"idle" | "adding" | "added" | "existed" | "error">("idle");

  async function addToVocab(term: string) {
    setVocab("adding");
    try {
      const r = await fetch("/api/job-hunter/interview/vocab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          term,
          en: res?.en || "",
          ipa: res?.ipa || "",
          zh: res?.zh || "",
          note: res?.note || "",
          context: text.slice(0, 1000),
        }),
      });
      const j = await r.json().catch(() => null);
      setVocab(!r.ok || !j?.success ? "error" : j.existed ? "existed" : "added");
    } catch {
      setVocab("error");
    }
  }

  async function speakTerm(text: string) {
    try {
      setSpeaking(true);
      const r = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.ok) playTts(await r.blob(), termAudioRef);
    } catch {
      /* ignore */
    } finally {
      setSpeaking(false);
    }
  }

  useEffect(() => () => termAudioRef.current?.pause(), []);

  function onMouseUp() {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) return;
    const term = sel.toString().trim();
    if (!term || term.length > 80) return; // 只查词/短语
    if (!ref.current || !ref.current.contains(sel.anchorNode)) return;
    let rect: DOMRect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    setPop({ x: rect.left + rect.width / 2, y: rect.bottom, term });
    setRes(null);
    setVocab("idle");
    setLoading(true);
    const rid = ++reqIdRef.current;
    fetch("/api/job-hunter/interview/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: term, context: text.slice(0, 1500) }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (rid !== reqIdRef.current) return; // 已被新的划词取代
        setRes(
          j?.success
            ? { en: j.en || "", ipa: j.ipa || "", zh: j.zh, note: j.note || "" }
            : { en: "", ipa: "", zh: "翻译失败", note: "" },
        );
        if (j?.success && j.inVocab) setVocab("existed"); // 已在单词本则直接显示「已加入」
      })
      .catch(() => {
        if (rid === reqIdRef.current) setRes({ en: "", ipa: "", zh: "网络异常", note: "" });
      })
      .finally(() => {
        if (rid === reqIdRef.current) setLoading(false);
      });
  }

  // 点击浮层外或开始新的选择时关闭。
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

  return (
    <>
      <div ref={ref} onMouseUp={onMouseUp} className={className}>
        {text}
      </div>
      {pop &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              left: pop.x,
              top: pop.y + 8,
              transform: "translateX(-50%)",
              zIndex: 60,
              maxWidth: 320,
            }}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg"
          >
            {(() => {
              const enReading = res?.en?.trim() || "";
              const sameAsTerm = enReading.toLowerCase() === pop.term.trim().toLowerCase();
              return (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{pop.term}</span>
                    {/* 普通单词:音标直接跟在词后 */}
                    {res?.ipa && (sameAsTerm || !enReading) && (
                      <span className="text-xs text-slate-500">{res.ipa}</span>
                    )}
                    <button
                      onClick={() => speakTerm(enReading || pop.term)}
                      disabled={speaking}
                      title="发音"
                      className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 transition hover:border-cyan-300 hover:text-cyan-700 disabled:opacity-50"
                    >
                      {speaking ? "…" : "🔊"}
                    </button>
                  </div>
                  {/* 符号/运算符:显示英文读法 + 音标(不会读它) */}
                  {enReading && !sameAsTerm && (
                    <div className="mt-0.5 text-xs text-slate-500">
                      读作 <span className="font-medium text-slate-700">{enReading}</span>
                      {res?.ipa && <span className="ml-1 text-slate-500">{res.ipa}</span>}
                    </div>
                  )}
                </>
              );
            })()}
            {loading ? (
              <div className="mt-1 text-xs text-slate-400">翻译中…</div>
            ) : res ? (
              <div className="mt-1">
                <div className="text-sm text-slate-700">{res.zh}</div>
                {res.note && <div className="mt-0.5 text-xs text-slate-400">{res.note}</div>}
              </div>
            ) : null}
            {res && (
              <div className="mt-2 border-t border-slate-100 pt-2">
                {vocab === "added" || vocab === "existed" ? (
                  <span className="text-xs font-medium text-emerald-600">
                    {vocab === "existed" ? "✓ 已在单词本" : "✓ 已加入单词本"}
                  </span>
                ) : (
                  <button
                    onClick={() => addToVocab(pop.term)}
                    disabled={vocab === "adding"}
                    className="rounded-lg border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60"
                  >
                    {vocab === "adding" ? "加入中（生成例句）…" : vocab === "error" ? "重试加入单词本" : "➕ 加入单词本"}
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function PracticeCard({
  question,
  answer,
  setAnswer,
  grading,
  grade,
  error,
  onSubmit,
  onNext,
  nextLabel = "下一题 →",
  onExplain,
}: {
  question: CurrentQuestion;
  answer: string;
  setAnswer: (s: string) => void;
  grading: boolean;
  grade: GradeResult | null;
  error: string | null;
  onSubmit: () => void;
  onNext: () => void;
  nextLabel?: string;
  onExplain: () => void;
}) {
  // 录音能力探测放到挂载后,避免 SSR/水合不一致。
  const [canRecord, setCanRecord] = useState(false);
  useEffect(() => {
    setCanRecord(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  // —— 读题(用 OpenAI 合成更自然的语音朗读题干,替代浏览器机读音)——
  const [speaking, setSpeaking] = useState(false);
  const [loadingSpeech, setLoadingSpeech] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakAbortRef = useRef<AbortController | null>(null);
  // 同一题重复点「读题」时复用已生成的音频(缓存 blob),省一次 OpenAI 调用。
  const audioCacheRef = useRef<{ id: number; blob: Blob } | null>(null);

  function stopSpeak() {
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    audioRef.current?.pause();
    setSpeaking(false);
    setLoadingSpeech(false);
  }

  function speakBlob(blob: Blob) {
    setSpeaking(true);
    playTts(blob, audioRef, () => setSpeaking(false));
  }

  async function toggleSpeak() {
    if (speaking || loadingSpeech) {
      stopSpeak();
      return;
    }
    setSpeechError(null);
    const cached = audioCacheRef.current;
    if (cached && cached.id === question.questionId) {
      speakBlob(cached.blob);
      return;
    }
    setLoadingSpeech(true);
    const ctrl = new AbortController();
    speakAbortRef.current = ctrl;
    try {
      const res = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: question.prompt }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setSpeechError(j?.error || "读题失败,请重试");
        setLoadingSpeech(false);
        return;
      }
      const blob = await res.blob();
      if (ctrl.signal.aborted) return;
      audioCacheRef.current = { id: question.questionId, blob };
      setLoadingSpeech(false);
      speakBlob(blob);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setSpeechError("读题失败,请重试");
      setLoadingSpeech(false);
    }
  }

  // 换题时:停止播放并清理上一题的音频缓存。
  useEffect(() => {
    audioRef.current?.pause();
    speakAbortRef.current?.abort();
    setSpeaking(false);
    setLoadingSpeech(false);
    setSpeechError(null);
    audioCacheRef.current = null;
  }, [question.questionId]);

  // 卸载时收尾:停音频、取消未完成的请求。
  useEffect(
    () => () => {
      audioRef.current?.pause();
      speakAbortRef.current?.abort();
      const a = audioRef.current;
      if (a && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
    },
    [],
  );

  // —— 语音作答(录音 → OpenAI 转写 → 填入答案框)——
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // 用 ref 保存最新答案,避免录音结束回调里拿到过期闭包值。
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  async function startRec() {
    setVoiceError(null);
    if (!canRecord) {
      setVoiceError("当前浏览器不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "answer.webm");
          const res = await fetch("/api/job-hunter/interview/transcribe", { method: "POST", body: fd });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.success) {
            setVoiceError(json?.error || "转写失败,请重试");
          } else if (json.text) {
            const prev = answerRef.current.trim();
            setAnswer(prev ? `${prev} ${json.text}` : json.text);
          }
        } catch {
          setVoiceError("网络异常,转写失败");
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
    } catch {
      setVoiceError("无法访问麦克风(请允许麦克风权限)");
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

  // 卸载时收尾:停止录音与音轨。
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

  // —— 转成英文面试版(用中文/任意语言作答 → AI 改写成可说出口的英文作答)——
  const [englishifying, setEnglishifying] = useState(false);
  const [englishError, setEnglishError] = useState<string | null>(null);
  const [canUndoEnglish, setCanUndoEnglish] = useState(false);
  const prevAnswerRef = useRef<string | null>(null);

  async function toEnglish() {
    const text = answerRef.current.trim();
    if (!text) {
      setEnglishError("请先写下你的作答(可用中文),再转成英文。");
      return;
    }
    setEnglishError(null);
    setEnglishifying(true);
    try {
      const res = await fetch("/api/job-hunter/interview/englishify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.questionId, answer: text }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setEnglishError(json?.error || "生成英文版失败,请重试");
      } else if (json.english) {
        prevAnswerRef.current = answerRef.current;
        setCanUndoEnglish(true);
        setAnswer(json.english);
      }
    } catch {
      setEnglishError("网络异常,请重试");
    } finally {
      setEnglishifying(false);
    }
  }

  function undoEnglish() {
    if (prevAnswerRef.current != null) {
      setAnswer(prevAnswerRef.current);
      prevAnswerRef.current = null;
      setCanUndoEnglish(false);
    }
  }

  // 换题时复位英文改写状态。
  useEffect(() => {
    setEnglishError(null);
    setCanUndoEnglish(false);
    prevAnswerRef.current = null;
  }, [question.questionId]);

  const answerLocked = grading || !!grade;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">
          {question.skill.name}
        </span>
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {TYPE_LABEL[question.type]}
        </span>
        {question.srState && (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${SR_STATE_CLASS[question.srState]}`}>
            {SR_STATE_LABEL[question.srState]}
          </span>
        )}
        <button
          onClick={toggleSpeak}
          className="ml-auto rounded-lg border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600 transition hover:border-cyan-300 hover:text-cyan-700"
        >
          {loadingSpeech ? "🔄 生成语音…" : speaking ? "⏹ 停止朗读" : "🔊 读题"}
        </button>
      </div>
      <TranslatableText
        text={question.prompt}
        className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800"
      />
      {speechError && <p className="mt-1 text-xs text-rose-500">{speechError}</p>}

      {/* 语音作答工具条 */}
      {!answerLocked && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {canRecord ? (
            <button
              onClick={recording ? stopRec : startRec}
              disabled={transcribing}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-60 ${
                recording
                  ? "bg-rose-600 text-white hover:bg-rose-700"
                  : "border border-slate-200 text-slate-600 hover:border-cyan-300 hover:text-cyan-700"
              }`}
            >
              {recording ? "● 停止并转写" : "🎙️ 语音作答"}
            </button>
          ) : (
            <span className="text-xs text-slate-400">（此浏览器不支持录音，可直接打字）</span>
          )}
          <button
            onClick={toEnglish}
            disabled={englishifying || recording}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-60"
          >
            {englishifying ? "转换中…" : "🌐 转成英文面试版"}
          </button>
          {canUndoEnglish && (
            <button onClick={undoEnglish} className="text-xs text-slate-400 underline hover:text-slate-600">
              ↩︎ 恢复原文
            </button>
          )}
          <button
            onClick={onExplain}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-cyan-300 hover:text-cyan-700"
          >
            🤔 不会，直接看讲解
          </button>
          {recording && <span className="text-xs text-rose-500">录音中……说完点「停止并转写」</span>}
          {transcribing && <span className="text-xs text-slate-400">正在转写……</span>}
          {voiceError && <span className="text-xs text-rose-500">{voiceError}</span>}
          {englishError && <span className="text-xs text-rose-500">{englishError}</span>}
        </div>
      )}

      {canUndoEnglish && !answerLocked && (
        <p className="mt-2 text-xs text-indigo-600">
          ✅ 已按你的作答生成英文面试版，可再编辑后「提交作答」；提交的就是这份英文答案。
        </p>
      )}

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="可先用中文作答，再点「🌐 转成英文面试版」；也可直接打字或「🎙️ 语音作答」……"
        rows={7}
        disabled={answerLocked}
        className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 disabled:bg-slate-50"
      />

      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

      {!grade ? (
        <button
          onClick={onSubmit}
          disabled={grading}
          className="mt-3 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
        >
          {grading ? "AI 正在评分…" : "提交作答"}
        </button>
      ) : (
        <GradeView grade={grade} onNext={onNext} nextLabel={nextLabel} />
      )}
    </div>
  );
}

function GradeView({
  grade,
  onNext,
  nextLabel,
}: {
  grade: GradeResult;
  onNext: () => void;
  nextLabel: string;
}) {
  const g = grade.grade;
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center justify-center rounded-xl bg-cyan-50 px-4 py-2">
          <span className="text-2xl font-bold text-cyan-600">{g.total}</span>
          <span className="text-[10px] text-cyan-500">/ 100</span>
        </div>
        <p className="text-xs text-slate-500">该技能掌握度已更新为 {Math.round(grade.mastery)} 分</p>
      </div>

      {grade.review && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          <span aria-hidden>🧠</span>
          <span>
            {grade.review.passed ? "记住了！" : "还没稳，"}
            按遗忘曲线，这道题
            <span className="font-semibold">{grade.review.nextReviewLabel}</span>
            再复习（当前：{SR_STATE_LABEL[grade.review.state]}）。
          </span>
        </div>
      )}

      {g.criteria.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {g.criteria.map((c, i) => (
            <div key={i} className="text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-700">{c.criterion}</span>
                <span className="text-xs font-semibold text-slate-500">{c.score}</span>
              </div>
              {c.comment && <p className="text-xs text-slate-500">{c.comment}</p>}
              {c.commentEn && <p className="text-xs italic text-slate-400">{c.commentEn}</p>}
            </div>
          ))}
        </div>
      )}

      <FeedbackList title="✅ 答对" items={g.hits} tone="emerald" />
      <FeedbackList title="⚠️ 遗漏" items={g.misses} tone="amber" />
      <FeedbackList title="❌ 错误" items={g.errors} tone="rose" />
      <FeedbackList title="💡 改进建议" items={g.advice} tone="slate" />

      <details className="mt-3 rounded-xl bg-slate-50 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-600">
          查看参考答案（可划词翻译）
        </summary>
        <TranslatableText
          text={grade.referenceAnswer}
          className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700"
        />
      </details>

      <button
        onClick={onNext}
        className="mt-4 rounded-xl bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-700"
      >
        {nextLabel}
      </button>
    </div>
  );
}

function FeedbackList({
  title,
  items,
  tone,
}: {
  title: string;
  items: BiText[];
  tone: "emerald" | "amber" | "rose" | "slate";
}) {
  if (!items.length) return null;
  const color = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    slate: "text-slate-600",
  }[tone];
  return (
    <div className="mt-3">
      <p className={`text-xs font-semibold ${color}`}>{title}</p>
      <ul className="mt-1 space-y-1.5 text-sm text-slate-600">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-slate-300">·</span>
            <span>
              {it.zh && <span className="block">{it.zh}</span>}
              {it.en && <span className="block text-xs italic text-slate-400">{it.en}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CoachCard({
  loading,
  coach,
  cached,
  sessionId,
  kind,
  targetId,
  promptText,
  sr,
  onRated,
  onClose,
  onRegenerate,
}: {
  loading: boolean;
  coach: { lesson: string; modelAnswer: string; practiceQuestion: string } | null;
  cached: boolean;
  sessionId: number;
  kind: "skill" | "question";
  targetId: number | null;
  promptText?: string | null;
  sr: { lastPct: number | null; reviewed: boolean; nextReviewLabel: string | null } | null;
  onRated: () => void;
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const [pct, setPct] = useState(60);
  const [rating, setRating] = useState(false);
  const [rated, setRated] = useState<{ pct: number; label: string } | null>(null);
  const isQuestion = kind === "question";

  // 换目标时:滑块默认到上次理解度(或 60),清掉本次评分结果。
  useEffect(() => {
    setPct(sr?.lastPct ?? 60);
    setRated(null);
  }, [targetId, kind, sr?.lastPct]);

  async function rate() {
    if (!targetId) return;
    setRating(true);
    try {
      const url = isQuestion
        ? "/api/job-hunter/interview/explain/rate"
        : "/api/job-hunter/interview/coach/rate";
      const body = isQuestion ? { questionId: targetId, pct } : { sessionId, skillId: targetId, pct };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) {
        setRated({ pct, label: j.nextReviewLabel });
        onRated();
      }
    } catch {
      /* ignore */
    } finally {
      setRating(false);
    }
  }

  return (
    <div className="rounded-2xl border border-cyan-200 bg-cyan-50/50 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-cyan-900">{isQuestion ? "📘 这道题的讲解" : "📚 弱点补强"}</p>
          {coach && !loading && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                cached ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
              }`}
            >
              {cached ? "已保存的讲解" : "刚生成并保存"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onRegenerate}
            disabled={loading}
            className="text-xs text-slate-400 transition hover:text-cyan-700 disabled:opacity-50"
          >
            重新生成
          </button>
          <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
            关闭
          </button>
        </div>
      </div>
      {coach && !loading && (
        <p className="mt-1 text-xs text-slate-400">
          {cached
            ? `这是之前保存的讲解(${isQuestion ? "这道题" : "该技能"}每次都给这篇);想换点「重新生成」。`
            : "已保存,下次打开还是这篇;想换点「重新生成」。"}
        </p>
      )}
      {loading && (
        <p className="mt-2 text-sm text-slate-500">
          {isQuestion ? "正在按这道题生成讲解(首次约 20 秒)……" : "正在载入讲解(首次需生成,约 20 秒)……"}
        </p>
      )}
      {coach && (
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">
          {isQuestion && promptText && (
            <div className="rounded-xl border border-slate-100 bg-white/70 p-3">
              <p className="text-xs font-semibold text-slate-500">题目（可划词翻译）</p>
              <TranslatableText text={promptText} className="mt-1 whitespace-pre-wrap font-medium text-slate-800" />
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-slate-500">讲解（可划词翻译）</p>
            <TranslatableText text={coach.lesson} className="mt-1 whitespace-pre-wrap" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">示范回答（可划词翻译）</p>
            <TranslatableText text={coach.modelAnswer} className="mt-1 whitespace-pre-wrap" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">练习题（可划词翻译）</p>
            <TranslatableText text={coach.practiceQuestion} className="mt-1 whitespace-pre-wrap" />
          </div>

          {/* 理解度滑块 → 遗忘曲线复习 */}
          <div className="mt-1 rounded-xl border border-cyan-100 bg-white/70 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-600">读完了?拖一下「我理解了多少」,按遗忘曲线排复习</p>
              <span className="text-sm font-bold text-cyan-700">{pct}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="mt-2 w-full accent-cyan-600"
            />
            <div className="mt-1 flex justify-between text-[10px] text-slate-400">
              <span>0 完全不懂</span>
              <span>60 大概懂</span>
              <span>100 很清楚</span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={rate}
                disabled={rating}
                className="rounded-xl bg-cyan-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
              >
                {rating ? "记录中…" : rated ? "更新理解度" : "记下理解度(排复习)"}
              </button>
              {rated ? (
                <span className="text-xs text-emerald-600">
                  已记下(理解 {rated.pct}%)：{rated.label}再复习。
                </span>
              ) : sr?.reviewed && sr.nextReviewLabel ? (
                <span className="text-xs text-slate-400">
                  上次理解 {sr.lastPct ?? "-"}%,原定 {sr.nextReviewLabel}复习。
                </span>
              ) : (
                <span className="text-xs text-slate-400">还没排过复习。</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 讲解复习面板:列出你点过「不会」并生成讲解的【题目】(带遗忘曲线状态),点开重读、按理解度复习。 */
function CoachReviewPanel({
  sessionId,
  onOpen,
}: {
  sessionId: number;
  onOpen: (questionId: number) => void;
}) {
  const [cards, setCards] = useState<
    | {
        questionId: number;
        prompt: string;
        skill: string;
        category: string;
        lastPct: number | null;
        isDue: boolean;
        dueAt: string | null;
        state: SrState;
      }[]
    | null
  >(null);
  const [counts, setCounts] = useState<{ total: number; due: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/job-hunter/interview/explain/cards?sessionId=${sessionId}`);
        const j = await r.json().catch(() => null);
        if (j?.success) {
          setCards(j.cards);
          setCounts(j.counts);
        } else setCards([]);
      } catch {
        setCards([]);
      }
    })();
  }, [sessionId]);

  if (!cards || cards.length === 0) return null; // 没生成过讲解就不显示

  return (
    <div className="rounded-2xl border border-cyan-200 bg-cyan-50/40 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-cyan-900">📖 讲解复习（遗忘曲线）</p>
        {counts && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              counts.due > 0 ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
            }`}
          >
            {counts.due > 0 ? `${counts.due} 篇待复习` : "已清空"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-cyan-700">你点过「不会」看讲解的题目,按遗忘曲线安排复习;点「复习」重读并更新理解度。</p>
      <div className="mt-3 space-y-2">
        {cards.map((c) => (
          <div
            key={c.questionId}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-700">{c.prompt}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <span className="rounded bg-slate-50 px-1 py-0.5 text-slate-500">{c.skill}</span>
                <span className={`rounded px-1 py-0.5 font-medium ${SR_STATE_CLASS[c.state]}`}>
                  {SR_STATE_LABEL[c.state]}
                </span>
                {c.lastPct != null && <span>理解 {c.lastPct}%</span>}
                {!c.isDue && c.dueAt && <span>下次 {c.dueAt.slice(0, 10)}</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {c.isDue && (
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600">待复习</span>
              )}
              <button
                onClick={() => onOpen(c.questionId)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-cyan-300 hover:text-cyan-700"
              >
                复习
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryPanel({ answers }: { answers: AnswerSummary[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">最近作答</p>
      <div className="mt-3 space-y-2">
        {answers.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-slate-600">
              <span className="text-xs text-slate-400">[{a.skill}]</span> {a.prompt}
            </span>
            <span className="shrink-0 text-xs font-semibold text-slate-500">{a.total}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 技术八股文:输入技术名(或留空按简历)生成 concept 概念题,追加进同一题库(存 Aiven)。可清空。 */
function FundamentalsPanel({
  sessionId,
  count,
  onDone,
}: {
  sessionId: number;
  count: number;
  onDone: () => void;
}) {
  const [topics, setTopics] = useState("");
  const [busy, setBusy] = useState<"gen" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "gen" | "clear") {
    setBusy(action);
    setError(null);
    try {
      const body =
        action === "clear" ? { sessionId, clear: true } : { sessionId, topics: topics.trim() };
      const res = await fetch("/api/job-hunter/interview/fundamentals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setError(json?.error || "生成失败,请重试(题目多时可能超时,建议在本地生成)。");
      } else {
        if (action === "gen") setTopics("");
        onDone();
      }
    } catch {
      setError("网络异常,请重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-amber-900">🧱 技术八股文</p>
        {count > 0 && (
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-600">
            已生成 {count} 道
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-amber-700">
        输入想练的技术(逗号分隔),按这些出经典概念题、追加进本题库并按遗忘曲线复习;<b>留空</b>则按这份简历的技术栈自动出。生成较慢(约 1 分钟)。
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) run("gen");
          }}
          placeholder="如 Java, Spring Boot, Spring MVC, Redis(留空 = 按简历技术栈)"
          disabled={!!busy}
          className="flex-1 rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 disabled:bg-slate-50"
        />
        <button
          onClick={() => run("gen")}
          disabled={!!busy}
          className="shrink-0 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "gen" ? "生成中（约 1 分钟）…" : "生成八股文 →"}
        </button>
      </div>
      {count > 0 && (
        <button
          onClick={() => run("clear")}
          disabled={!!busy}
          className="mt-2 text-xs text-slate-400 underline transition hover:text-rose-600 disabled:opacity-50"
        >
          {busy === "clear" ? "清空中…" : "清空全部八股文"}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  );
}

function BankPicker({ banks }: { banks: BankSummary[] | null }) {
  if (banks === null) return <p className="text-sm text-slate-400">正在加载题库……</p>;
  if (banks.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
        还没有题库。去{" "}
        <Link href="/job-hunter" className="font-semibold text-indigo-600 underline">
          求职投递一条龙
        </Link>{" "}
        上传简历、点「生成题库」，之后就会出现在这里。
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">选择要复习的题库（按人名 / 简历）</p>
      <div className="mt-3 space-y-2">
        {banks.map((b) => (
          // 用整页跳转(<a>)而非 <Link>:本页只在挂载时读一次 ?session=,同路由的
          // 客户端软跳转不会重挂载 → 点了没反应。整页导航强制重挂载、正确读到 session。
          <a
            key={b.id}
            href={`/job-hunter/interview?session=${b.id}`}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-4 py-3 transition hover:border-indigo-300 hover:bg-indigo-50/40"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-800">{b.title}</div>
              <div className="mt-0.5 text-xs text-slate-400">
                {b.language} · {b.total} 题 · 生成于 {String(b.created_at).slice(0, 10)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {b.due > 0 ? (
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600">
                  {b.due} 待复习
                </span>
              ) : (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
                  已清空
                </span>
              )}
              <span className="text-sm text-indigo-500">复习 →</span>
            </div>
          </a>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        想加新简历的题库？去{" "}
        <Link href="/job-hunter" className="text-indigo-600 underline">
          求职投递一条龙
        </Link>{" "}
        生成。
      </p>
    </div>
  );
}

function ReviewDashboard({
  counts,
  busy,
  exhausted,
  hasQuestion,
  onStart,
}: {
  counts: SrCounts;
  busy: boolean;
  exhausted: boolean;
  hasQuestion: boolean;
  onStart: () => void;
}) {
  const ready = counts.due + counts.fresh;
  return (
    <div className="rounded-2xl border border-indigo-200 bg-gradient-to-b from-indigo-50/70 to-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-indigo-900">🧠 遗忘曲线复习</p>
        <span className="text-xs text-slate-400">共 {counts.total} 题</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat label="今日到期" value={counts.due} tone="rose" />
        <Stat label="新题" value={counts.fresh} tone="sky" />
        <Stat label="已排期" value={counts.later} tone="slate" />
        <Stat label="已掌握" value={counts.mastered} tone="emerald" />
      </div>
      {exhausted ? (
        <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          🎉 今日复习已清空！已排期的题到期后会再出现，明天再来吧。
        </p>
      ) : (
        <button
          onClick={onStart}
          disabled={busy || ready === 0}
          className="mt-4 w-full rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy
            ? "加载中…"
            : ready === 0
              ? "今日无到期题 🎉"
              : hasQuestion
                ? `继续复习（还剩 ${ready} 张）`
                : `开始复习（${counts.due} 到期 · ${counts.fresh} 新题）`}
        </button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "rose" | "sky" | "slate" | "emerald";
}) {
  const cls = {
    rose: "text-rose-600",
    sky: "text-sky-600",
    slate: "text-slate-600",
    emerald: "text-emerald-600",
  }[tone];
  return (
    <div className="rounded-xl bg-white/70 py-2">
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function BankPanel({
  items,
  onPractice,
  busy,
}: {
  items: BankItem[];
  onPractice: (i: BankItem) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">题库（{items.length} 题 · 按遗忘曲线复习）</p>
      <div className="mt-3 space-y-2">
        {items.map((it) => (
          <div
            key={it.id}
            className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700">
                  {it.skill}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                  {TYPE_LABEL[it.type]}
                </span>
                {it.source === "fundamentals" && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                    八股
                  </span>
                )}
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${SR_STATE_CLASS[it.state]}`}>
                  {SR_STATE_LABEL[it.state]}
                </span>
                {it.isDue ? (
                  <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600">
                    待复习
                  </span>
                ) : it.dueAt ? (
                  <span className="text-[11px] text-slate-400">下次 {it.dueAt.slice(0, 10)}</span>
                ) : null}
                {it.lastScore != null && (
                  <span className="text-[11px] text-slate-400">上次 {it.lastScore} 分</span>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-slate-600">{it.prompt}</p>
            </div>
            <button
              onClick={() => onPractice(it)}
              disabled={busy}
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50"
            >
              练这道
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function KbManager() {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/job-hunter/interview/kb");
      const json = await res.json().catch(() => null);
      if (json?.success) setDocs(json.docs as KbDoc[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function upload(form: FormData) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/job-hunter/interview/kb", { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) setMsg(json?.error || "上传失败");
      else {
        setMsg(`已加入 ${json.chunkCount} 个片段`);
        setPasteText("");
        if (fileRef.current) fileRef.current.value = "";
        load();
      }
    } catch {
      setMsg("网络异常");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/job-hunter/interview/kb?id=${id}`, { method: "DELETE" });
    load();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-cyan-300 hover:text-cyan-700"
      >
        📚 知识库
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">自定义知识库（出题/评分会优先依据它）</p>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">
          收起
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:border-cyan-300">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const fd = new FormData();
              fd.append("file", f);
              upload(fd);
            }}
          />
          上传 PDF / DOCX
        </label>
        {busy && <span className="text-xs text-slate-400">处理中…</span>}
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      <div className="mt-2 flex gap-2">
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="或粘贴笔记/八股文本……"
          rows={2}
          className="flex-1 resize-y rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-cyan-400"
        />
        <button
          onClick={() => {
            if (!pasteText.trim()) return;
            const fd = new FormData();
            fd.append("text", pasteText);
            upload(fd);
          }}
          disabled={busy || !pasteText.trim()}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          加入
        </button>
      </div>

      {docs.length > 0 && (
        <ul className="mt-3 space-y-1">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between text-xs text-slate-500">
              <span className="truncate">
                📄 {d.title} <span className="text-slate-300">· {d.chunk_count} 片段</span>
              </span>
              <button onClick={() => remove(d.id)} className="ml-2 shrink-0 text-rose-400 hover:text-rose-600">
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type VocabItem = {
  id: number;
  term: string;
  en: string;
  ipa: string;
  zh: string;
  note: string;
  example: string;
  exampleZh: string;
  state: SrState;
  isDue: boolean;
  dueAt: string | null;
  lastGrade: string | null;
};

type VocabCounts = { total: number; due: number; fresh: number; mastered: number };

/** 单词本:划词加入的生词按遗忘曲线复习(闪卡:显示词→揭示释义/例句→不记得/似乎记得/清楚 自评)。 */
function VocabManager() {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState<VocabItem[]>([]);
  const [counts, setCounts] = useState<VocabCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [queue, setQueue] = useState<VocabItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [regenId, setRegenId] = useState<number | null>(null);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/job-hunter/interview/vocab");
      const j = await r.json().catch(() => null);
      if (j?.success) {
        setWords(j.words as VocabItem[]);
        setCounts(j.counts as VocabCounts);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  useEffect(() => () => audioRef.current?.pause(), []);

  async function speak(text: string) {
    try {
      const r = await fetch("/api/job-hunter/interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.ok) playTts(await r.blob(), audioRef);
    } catch {
      /* ignore */
    }
  }

  function startReview() {
    const due = words.filter((w) => w.isDue);
    if (!due.length) {
      setMsg("今日没有到期的单词 🎉");
      return;
    }
    setQueue(due);
    setIdx(0);
    setRevealed(false);
    setLastLabel(null);
    setMsg(null);
  }

  async function grade(g: "forgot" | "vague" | "clear") {
    const cur = queue[idx];
    if (!cur) return;
    setGrading(true);
    try {
      const r = await fetch("/api/job-hunter/interview/vocab/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cur.id, grade: g }),
      });
      const j = await r.json().catch(() => null);
      setLastLabel(j?.success ? `${cur.term} → ${j.nextReviewLabel}复习` : null);
    } catch {
      /* ignore */
    } finally {
      setGrading(false);
    }
    if (idx + 1 >= queue.length) {
      setQueue([]);
      setIdx(0);
      setRevealed(false);
      setMsg("本轮复习完成 🎉");
      load();
    } else {
      setIdx(idx + 1);
      setRevealed(false);
    }
  }

  async function regenExample(id: number) {
    setRegenId(id);
    try {
      const r = await fetch("/api/job-hunter/interview/vocab/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.success) {
        const patch = (w: VocabItem) =>
          w.id === id ? { ...w, en: j.en ?? w.en, example: j.example, exampleZh: j.exampleZh } : w;
        setWords((ws) => ws.map(patch));
        setQueue((q) => q.map(patch));
      }
    } catch {
      /* ignore */
    } finally {
      setRegenId(null);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/job-hunter/interview/vocab?id=${id}`, { method: "DELETE" });
    load();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700"
      >
        📓 单词本{counts && counts.due > 0 ? `（${counts.due} 待复习）` : ""}
      </button>
    );
  }

  const cur = queue.length > 0 ? queue[idx] : null;
  // 英文读法 ≠ 原词(即选中的是中文/符号):音标应挂在「读作」行,而不是原词后面。
  const enDiffers = !!cur?.en && cur.en.toLowerCase() !== cur.term.trim().toLowerCase();

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">📓 单词本 · 遗忘曲线复习</p>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">
          收起
        </button>
      </div>

      {counts && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          <Stat label="待复习" value={counts.due} tone="rose" />
          <Stat label="新词" value={counts.fresh} tone="sky" />
          <Stat label="已掌握" value={counts.mastered} tone="emerald" />
          <Stat label="总数" value={counts.total} tone="slate" />
        </div>
      )}

      {msg && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</p>}

      {cur ? (
        <div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
          <div className="text-xs text-slate-400">
            第 {idx + 1} / {queue.length} 张
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-lg font-bold text-slate-800">{cur.term}</span>
            {/* 普通词:音标直接跟在词后;符号/短语(读法≠原词)则把音标放到「读作」行 */}
            {cur.ipa && !enDiffers && <span className="text-sm text-slate-500">{cur.ipa}</span>}
            <button
              onClick={() => speak(cur.en || cur.term)}
              className="rounded-md border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 transition hover:border-cyan-300 hover:text-cyan-700"
            >
              🔊
            </button>
          </div>
          {enDiffers && (
            <div className="mt-0.5 text-xs text-slate-500">
              读作 <span className="font-medium text-slate-700">{cur.en}</span>
              {cur.ipa && <span className="ml-1 text-slate-500">{cur.ipa}</span>}
            </div>
          )}
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="mt-3 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
            >
              显示释义
            </button>
          ) : (
            <div className="mt-3 space-y-2">
              <div className="text-sm text-slate-700">{cur.zh}</div>
              {cur.note && <div className="text-xs text-slate-400">{cur.note}</div>}
              {cur.example && (
                <div className="rounded-lg bg-white p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-slate-700">{cur.example}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => speak(cur.example)}
                        className="rounded border border-slate-200 px-1 text-xs text-slate-400 transition hover:text-cyan-700"
                      >
                        🔊
                      </button>
                      <button
                        onClick={() => regenExample(cur.id)}
                        disabled={regenId === cur.id}
                        title="换个全英文例句"
                        className="rounded border border-slate-200 px-1 text-xs text-slate-400 transition hover:text-cyan-700 disabled:opacity-50"
                      >
                        {regenId === cur.id ? "…" : "🔄"}
                      </button>
                    </div>
                  </div>
                  {cur.exampleZh && <div className="mt-1 text-xs text-slate-400">{cur.exampleZh}</div>}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => grade("forgot")}
                  disabled={grading}
                  className="flex-1 rounded-xl bg-rose-100 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-200 disabled:opacity-60"
                >
                  不记得
                </button>
                <button
                  onClick={() => grade("vague")}
                  disabled={grading}
                  className="flex-1 rounded-xl bg-amber-100 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-200 disabled:opacity-60"
                >
                  似乎记得
                </button>
                <button
                  onClick={() => grade("clear")}
                  disabled={grading}
                  className="flex-1 rounded-xl bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-200 disabled:opacity-60"
                >
                  清楚
                </button>
              </div>
            </div>
          )}
          {lastLabel && <p className="mt-2 text-xs text-indigo-600">上一张：{lastLabel}</p>}
        </div>
      ) : (
        <div className="mt-4">
          <button
            onClick={startReview}
            disabled={loading || !counts || counts.due === 0}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {counts && counts.due > 0 ? `开始复习（${counts.due} 待复习）` : "暂无到期单词"}
          </button>
        </div>
      )}

      {words.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold text-slate-500">全部单词（{words.length}）</p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {words.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-slate-700">{w.term}</span>
                  <span className="ml-2 text-xs text-slate-400">{w.zh}</span>
                  <span className={`ml-2 rounded px-1 py-0.5 text-[10px] font-medium ${SR_STATE_CLASS[w.state]}`}>
                    {SR_STATE_LABEL[w.state]}
                  </span>
                </span>
                <button onClick={() => remove(w.id)} className="shrink-0 text-xs text-rose-400 hover:text-rose-600">
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && <p className="mt-2 text-xs text-slate-400">加载中…</p>}
    </div>
  );
}
