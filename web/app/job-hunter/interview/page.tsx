"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

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

type Grade = {
  total: number;
  criteria: Array<{ criterion: string; score: number; comment: string }>;
  hits: string[];
  misses: string[];
  errors: string[];
  advice: string[];
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

  const [coachSkillId, setCoachSkillId] = useState<number | null>(null);
  const [coach, setCoach] = useState<{ lesson: string; modelAnswer: string; practiceQuestion: string } | null>(null);
  const [coaching, setCoaching] = useState(false);

  const [reviewExhausted, setReviewExhausted] = useState(false);

  const practiceRef = useRef<HTMLDivElement | null>(null);
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
    if (sessionId) loadProgress(sessionId);
    else setLoadingProgress(false);
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
      skill: { id: 0, name: item.skill, category: item.category },
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

  async function requestCoach(skillId: number) {
    if (!sessionId) return;
    setCoachSkillId(skillId);
    setCoach(null);
    setCoaching(true);
    const { ok, data, error } = await postJson<{ coach: typeof coach; success: boolean }>(
      "/api/job-hunter/interview/coach",
      { sessionId, skillId },
    );
    setCoaching(false);
    if (ok && data?.coach) setCoach(data.coach);
    else setProgressError(error ?? "生成补强内容失败");
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href="/job-hunter" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回求职神器
        </Link>
        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-600">
            {isBank ? "简历面试题库 · Interview Bank" : "专项面试训练 · Interview Prep"}
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {isBank ? "按你的简历刷面试题" : "针对这份 JD 练到会"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {isBank
              ? "我当面试官、按你简历里的真实经历出题（以行为面试 BQ 为主）；你打字作答，AI 评分并给参考答案，每道题按遗忘曲线自动安排下次复习。进度自动保存。"
              : "按岗位技能出题、打字作答、AI 评分定位弱点，自适应优先练你最薄弱的部分。进度自动保存。"}
          </p>
          {isBank && progress?.session.title && (
            <p className="mt-1 text-xs text-slate-400">题库绑定简历：{progress.session.title}</p>
          )}
        </header>

        {!sessionId && !loadingProgress && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
            没有训练会话。请先到{" "}
            <Link href="/job-hunter" className="font-semibold underline">
              求职神器
            </Link>{" "}
            生成简历，再点「开始训练」。
          </p>
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
            </div>

            {/* 补强内容 */}
            {coachSkillId !== null && (
              <CoachCard
                loading={coaching}
                coach={coach}
                onClose={() => {
                  setCoachSkillId(null);
                  setCoach(null);
                }}
              />
            )}

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
}) {
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
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{question.prompt}</p>

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="在这里打字作答……"
        rows={7}
        disabled={grading || !!grade}
        className="mt-4 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 disabled:bg-slate-50"
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
              {c.comment && <p className="text-xs text-slate-400">{c.comment}</p>}
            </div>
          ))}
        </div>
      )}

      <FeedbackList title="✅ 答对" items={g.hits} tone="emerald" />
      <FeedbackList title="⚠️ 遗漏" items={g.misses} tone="amber" />
      <FeedbackList title="❌ 错误" items={g.errors} tone="rose" />
      <FeedbackList title="💡 改进建议" items={g.advice} tone="slate" />

      <details className="mt-3 rounded-xl bg-slate-50 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-600">查看参考答案</summary>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {grade.referenceAnswer}
        </p>
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
  items: string[];
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
      <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-slate-300">·</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CoachCard({
  loading,
  coach,
  onClose,
}: {
  loading: boolean;
  coach: { lesson: string; modelAnswer: string; practiceQuestion: string } | null;
  onClose: () => void;
}) {
  return (
    <div className="rounded-2xl border border-cyan-200 bg-cyan-50/50 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-cyan-900">📚 弱点补强</p>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
          关闭
        </button>
      </div>
      {loading && <p className="mt-2 text-sm text-slate-500">正在生成讲解……</p>}
      {coach && (
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">
          <div>
            <p className="text-xs font-semibold text-slate-500">讲解</p>
            <p className="mt-1 whitespace-pre-wrap">{coach.lesson}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">示范回答</p>
            <p className="mt-1 whitespace-pre-wrap">{coach.modelAnswer}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">练习题</p>
            <p className="mt-1 whitespace-pre-wrap">{coach.practiceQuestion}</p>
          </div>
        </div>
      )}
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
