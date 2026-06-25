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

type Progress = {
  session: { id: number; language: string };
  skills: Skill[];
  recentAnswers: AnswerSummary[];
};

type CurrentQuestion = {
  questionId: number;
  skill: { id: number; name: string; category: string };
  type: QuestionType;
  prompt: string;
};

type Grade = {
  total: number;
  criteria: Array<{ criterion: string; score: number; comment: string }>;
  hits: string[];
  misses: string[];
  errors: string[];
  advice: string[];
};

type GradeResult = { grade: Grade; mastery: number; referenceAnswer: string };

type KbDoc = { id: number; title: string; char_count: number; chunk_count: number };

const TYPE_LABEL: Record<QuestionType, string> = {
  concept: "概念题",
  scenario: "场景题",
  "system-design": "系统设计",
  behavioral: "行为面试",
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

  const practiceRef = useRef<HTMLDivElement | null>(null);

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
            专项面试训练 · Interview Prep
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            针对这份 JD 练到会
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            按岗位技能出题、打字作答、AI 评分定位弱点，自适应优先练你最薄弱的部分。进度自动保存。
          </p>
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
            <SkillPanel
              skills={progress.skills}
              onPractice={(id) => nextQuestion(id)}
              onCoach={requestCoach}
              busy={fetchingQuestion}
            />

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => nextQuestion()}
                disabled={fetchingQuestion || grading}
                className="rounded-xl bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-60"
              >
                {fetchingQuestion ? "正在出题…" : question ? "换一题（练最弱）" : "开始练习（练最弱）"}
              </button>
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
                  onNext={() => nextQuestion()}
                />
              )}
            </div>

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
}: {
  skills: Skill[];
  onPractice: (id: number) => void;
  onCoach: (id: number) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-slate-800">技能掌握度</p>
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
              <button
                onClick={() => onPractice(s.id)}
                disabled={busy}
                className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-cyan-300 hover:text-cyan-700 disabled:opacity-50"
              >
                练这个
              </button>
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
}: {
  question: CurrentQuestion;
  answer: string;
  setAnswer: (s: string) => void;
  grading: boolean;
  grade: GradeResult | null;
  error: string | null;
  onSubmit: () => void;
  onNext: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">
          {question.skill.name}
        </span>
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {TYPE_LABEL[question.type]}
        </span>
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
        <GradeView grade={grade} onNext={onNext} />
      )}
    </div>
  );
}

function GradeView({ grade, onNext }: { grade: GradeResult; onNext: () => void }) {
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
        下一题 →
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
