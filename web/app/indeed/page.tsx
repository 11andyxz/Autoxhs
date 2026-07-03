"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearHandoff,
  readHandoff,
  resumeExportFilename,
  type ResumeExportKind,
  type ResumeHandoff,
} from "@/lib/job-hunter/handoff";

// ---------- 类型（对齐 app/api/indeed/* 归一化后的响应） ----------

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string; // 传输层失败时的判别码：timeout | connection | badjson
};

type Health = {
  ok: boolean;
  sessionCookies: number;
  hasIndeedCsrf: boolean;
  cdpConnected: boolean;
  applicant: { firstName: string; lastName: string; email: string };
};

type Job = {
  jk: string;
  title: string;
  company: string;
  location: string;
  indeedApply: boolean;
};

type Question = {
  id: string;
  type: string;
  required: boolean;
  label: string;
  options: Array<{ value: string; label: string }> | null;
  autoAnswer: string | null;
};

type Answer = { questionId: string; value: string };

type KbMatch = {
  questionId: string;
  source: "exact" | "similar";
  value: string;
  valueLabel: string | null;
  confidence: number;
};

type DryRun = {
  jk: string;
  dryRun: true;
  note: string;
  questions: Question[];
  answers: Answer[];
  submitFields: Record<string, string>;
};

type SubmitResult = {
  jk: string;
  dryRun: false;
  submitted: boolean;
  errors: unknown;
  successPageUrl: string;
  dcmId: string;
  applied: boolean;
  appliedMs: number | null;
};

type AppliedResult = { jk: string; applied: boolean; appliedMs: number | null };

// ---------- fetch 小工具 ----------

async function callApi<T>(input: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(input, init);
    const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
    if (!json) return { success: false, error: "服务返回异常。" };
    return json;
  } catch {
    return { success: false, error: "网络错误，请重试。" };
  }
}

function fmtTime(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString("zh-CN");
  } catch {
    return String(ms);
  }
}

/** 把答案值解析成可读文本（SELECT/RADIO 用选项 label，空值显示「留空」）。 */
function answerLabel(q: Question | undefined, value: string): string {
  if (value === "" || value == null) return "（留空）";
  const opt = q?.options?.find((o) => o.value === value);
  return opt ? `${opt.label}（${value}）` : value;
}

// ---------- 小组件 ----------

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
      }`}
    >
      <span aria-hidden>{ok ? "●" : "○"}</span>
      {label}
    </span>
  );
}

function Banner({ tone, children }: { tone: "info" | "success" | "error"; children: React.ReactNode }) {
  const styles =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "error"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : "border-slate-200 bg-slate-50 text-slate-600";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

const btnBase =
  "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

/** 知识库命中徽章：精确 / 相似 / 需你填写。 */
function KbBadge({ match }: { match: KbMatch | undefined }) {
  if (!match) {
    return (
      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        需你填写
      </span>
    );
  }
  if (match.source === "exact") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        知识库 · 自动
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
      类似 · 请确认（{Math.round(match.confidence * 100)}%）
    </span>
  );
}

/** 单题作答输入：有选项 → 下拉；否则文本/数字输入。 */
function AnswerInput({
  q,
  value,
  onChange,
}: {
  q: Question;
  value: string;
  onChange: (v: string) => void;
}) {
  const cls =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400";
  if (q.options && q.options.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cls}>
        <option value="">请选择…</option>
        {q.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const numeric = /number|numeric|integer/i.test(q.type);
  return (
    <input
      type={numeric ? "number" : "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="请输入你的答案"
      className={cls}
    />
  );
}

// ---------- 页面 ----------

export default function IndeedPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [l, setL] = useState("");
  const [limit, setLimit] = useState(10);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [searched, setSearched] = useState(false);

  const [selectedJk, setSelectedJk] = useState<string | null>(null);

  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);

  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewedJk, setPreviewedJk] = useState<string | null>(null);

  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 投递超时/非 JSON：结果不确定（可能已提交），需先复核再决定是否重投。
  const [ambiguousSubmit, setAmbiguousSubmit] = useState(false);

  const [applied, setApplied] = useState<AppliedResult | null>(null);
  const [checkingApplied, setCheckingApplied] = useState(false);
  const [appliedError, setAppliedError] = useState<string | null>(null);

  // 从求职神器带入的定制简历（客户端交接，见 lib/job-hunter/handoff）。
  const [carried, setCarried] = useState<ResumeHandoff | null>(null);
  const [carriedDownloading, setCarriedDownloading] = useState<ResumeExportKind | null>(null);
  const [carriedError, setCarriedError] = useState<string | null>(null);

  // 雇主问题作答 + 知识库预填
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Record<string, KbMatch>>({});
  const [savingKb, setSavingKb] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const selectedJob = jobs.find((j) => j.jk === selectedJk) ?? null;

  // 挂载时读取带入的定制简历；若搜索词为空，用简历标题预填，方便直接搜岗位。
  useEffect(() => {
    const h = readHandoff();
    if (!h) return;
    setCarried(h);
    setQ((prev) => prev || h.result.resume.headline || "");
  }, []);

  async function handleDownloadCarried(kind: ResumeExportKind) {
    if (!carried) return;
    setCarriedError(null);
    setCarriedDownloading(kind);
    try {
      const res = await fetch("/api/job-hunter/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, result: carried.result }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setCarriedError(json?.error || "下载失败，请稍后重试。");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resumeExportFilename(kind, carried.result);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setCarriedError("下载失败，请稍后重试。");
    } finally {
      setCarriedDownloading(null);
    }
  }

  function handleClearCarried() {
    clearHandoff();
    setCarried(null);
    setCarriedError(null);
  }

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    const res = await callApi<Health>("/api/indeed/health");
    if (res.success && res.data) setHealth(res.data);
    else {
      setHealth(null);
      setHealthError(res.error ?? "无法获取服务状态。");
    }
    setHealthLoading(false);
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  // 选中岗位后自动读取雇主问题 + 知识库预填,并滚动到投递面板。
  useEffect(() => {
    if (!selectedJk) return;
    void handleLoadQuestions(selectedJk);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJk]);

  function resetSelectionState() {
    setQuestions(null);
    setQuestionsError(null);
    setAnswers({});
    setMatches({});
    setDryRun(null);
    setPreviewError(null);
    setPreviewedJk(null);
    setSubmitResult(null);
    setSubmitError(null);
    setAmbiguousSubmit(false);
    setApplied(null);
    setAppliedError(null);
  }

  function selectJob(jk: string) {
    if (jk === selectedJk) return;
    setSelectedJk(jk);
    resetSelectionState();
  }

  async function handleRefresh() {
    setRefreshing(true);
    await callApi("/api/indeed/refresh", { method: "POST" });
    await loadHealth();
    setRefreshing(false);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim() || searching) return;
    setSearching(true);
    setSearchError(null);
    setSearched(true);
    setSelectedJk(null);
    resetSelectionState();
    const params = new URLSearchParams({ q: q.trim(), limit: String(limit) });
    if (l.trim()) params.set("l", l.trim());
    const res = await callApi<{ jobs: Job[] }>(`/api/indeed/search?${params.toString()}`);
    if (res.success && res.data) setJobs(res.data.jobs);
    else {
      setJobs([]);
      setSearchError(res.error ?? "搜索失败。");
    }
    setSearching(false);
  }

  async function handleLoadQuestions(jkArg?: string) {
    const jk = jkArg ?? selectedJk;
    if (!jk || questionsLoading) return;
    setQuestionsLoading(true);
    setQuestionsError(null);
    const res = await callApi<{ questions: Question[]; matches?: Record<string, KbMatch> }>(
      `/api/indeed/questions?jk=${encodeURIComponent(jk)}`,
    );
    if (res.success && res.data) {
      setQuestions(res.data.questions);
      const m = res.data.matches ?? {};
      setMatches(m);
      // 用知识库命中预填答案(精确+相似都预填;相似会在 UI 标注请你确认)。
      const init: Record<string, string> = {};
      for (const qq of res.data.questions) {
        const hit = m[qq.id];
        if (hit) init[qq.id] = hit.value;
      }
      setAnswers(init);
    } else {
      setQuestionsError(res.error ?? "读取雇主问题失败。");
    }
    setQuestionsLoading(false);
  }

  function setAnswer(qid: string, value: string) {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  }

  /** 当前面板要提交/入库的题目集合。 */
  function currentQuestions(): Question[] {
    return questions ?? [];
  }

  /** 传给投递接口的答案(只带已填的;空的留给服务端默认自动答)。 */
  function answersPayload(): Answer[] {
    return currentQuestions()
      .map((qq) => ({ questionId: qq.id, value: (answers[qq.id] ?? "").toString() }))
      .filter((a) => a.questionId && a.value.trim().length > 0);
  }

  /** 未回答的必填题(用于禁用预演)。 */
  const requiredUnanswered = currentQuestions().filter(
    (qq) => qq.required && !(answers[qq.id] ?? "").toString().trim(),
  );

  /** 保存到知识库:把每道题连同当前答案(含选项 label)写库,仅存有值的。 */
  async function saveAnswersToKb() {
    const items = currentQuestions()
      .map((qq) => {
        const value = (answers[qq.id] ?? "").toString();
        const valueLabel = qq.options?.find((o) => o.value === value)?.label ?? null;
        return { label: qq.label, type: qq.type, options: qq.options, value, valueLabel };
      })
      .filter((it) => it.value.trim().length > 0);
    if (!items.length) return;
    setSavingKb(true);
    // 尽力而为:入库失败不阻断投递(答案仍会随预演发给服务)。
    await callApi("/api/indeed/kb/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    setSavingKb(false);
  }

  /** 卡片上的「一键投递」入口:选中岗位(触发自动读题/预填)。 */
  function startApplyForJob(jk: string) {
    if (jk === selectedJk) {
      void handleLoadQuestions(jk);
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    selectJob(jk); // selectedJk 变化会触发上面的 effect 自动读题 + 滚动
  }

  /** ① 保存答案入库 → 预演。 */
  async function handleSaveAndPreview() {
    if (!selectedJk || previewing || savingKb) return;
    await saveAnswersToKb();
    await handlePreview();
  }

  async function handlePreview() {
    if (!selectedJk || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    setDryRun(null);
    setPreviewedJk(null);
    setSubmitResult(null);
    setSubmitError(null);
    setAmbiguousSubmit(false);
    const res = await callApi<DryRun>("/api/indeed/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jk: selectedJk, confirm: false, answers: answersPayload() }),
    });
    if (res.success && res.data) {
      setDryRun(res.data);
      setPreviewedJk(selectedJk);
    } else {
      setPreviewError(res.error ?? "预演失败。");
    }
    setPreviewing(false);
  }

  async function handleConfirmApply() {
    if (!selectedJk || submitting) return;
    if (previewedJk !== selectedJk) return;
    const ok = window.confirm(
      `确认向雇主真实投递该岗位？\n\n${selectedJob?.title ?? ""} · ${selectedJob?.company ?? ""}\n\n此操作不可逆，将以本地服务登录的身份提交申请。`,
    );
    if (!ok) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    setAmbiguousSubmit(false);
    const res = await callApi<SubmitResult>("/api/indeed/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jk: selectedJk, confirm: true, answers: answersPayload() }),
    });
    if (res.success && res.data) {
      setSubmitResult(res.data);
      // 服务已给出确定结果：清掉预演闸门，禁用「确认投递」按钮，防止对同一岗位重复（不可逆）投递。
      setPreviewedJk(null);
    } else {
      setSubmitError(res.error ?? "投递失败。");
      // 超时/非 JSON：本次投递「可能」已在服务端完成，不能盲目重投。清掉闸门 → 禁用「确认投递」，
      // 逼用户先「复核投递状态」、必要时重新预演，杜绝重复（不可逆）投递。
      // 仅「连不上」是确定没生效，保留闸门以便直接重试。
      if (res.code !== "connection") {
        setPreviewedJk(null);
        setAmbiguousSubmit(true);
      }
    }
    setSubmitting(false);
  }

  async function handleCheckApplied() {
    if (!selectedJk || checkingApplied) return;
    setCheckingApplied(true);
    setAppliedError(null);
    const res = await callApi<AppliedResult>(
      `/api/indeed/applied?jk=${encodeURIComponent(selectedJk)}`,
    );
    if (res.success && res.data) setApplied(res.data);
    else setAppliedError(res.error ?? "复核状态失败。");
    setCheckingApplied(false);
  }

  const canConfirm = !!selectedJk && previewedJk === selectedJk && !submitting;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
        {/* 顶栏 */}
        <div className="mb-2 flex items-center justify-between">
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
            ← 返回工具箱
          </Link>
        </div>
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            🚀 一键投递 Indeed
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            搜索岗位 → 查看雇主问题与自动答案 → 先预演（不投递）→ 确认后一键真实投递 → 复核状态。
            仅 <span className="font-medium text-slate-700">indeedApply</span> 岗位可投；真实投递需本地
            Indeed 服务在运行、AdsPower 浏览器已打开并登录。
          </p>
        </header>

        {/* 从求职神器带入的定制简历 */}
        {carried && (
          <section className="mb-6 rounded-xl border border-cyan-200 bg-cyan-50/60 p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-cyan-900">🎯 已带入定制简历</p>
                <p className="mt-1 text-xs text-cyan-700">
                  {carried.result.resume.name}
                  {carried.result.resume.headline ? ` · ${carried.result.resume.headline}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={handleClearCarried}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                清除带入
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-amber-700">
              ⚠️ 一键投递用的是你 Indeed 账号里保存的简历。请先下载这份定制简历，更新到 Indeed
              账号（或在投递弹窗中附加），确保投出的是定制版。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleDownloadCarried("resume-docx")}
                disabled={carriedDownloading !== null}
                className={`${btnBase} bg-cyan-600 text-white hover:bg-cyan-700`}
              >
                {carriedDownloading === "resume-docx" ? "生成中…" : "下载定制简历 Word"}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadCarried("cover-pdf")}
                disabled={carriedDownloading !== null}
                className={`${btnBase} border border-cyan-200 bg-white text-cyan-700 hover:bg-cyan-50`}
              >
                {carriedDownloading === "cover-pdf" ? "生成中…" : "下载求职信 PDF"}
              </button>
              <Link href="/job-hunter" className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}>
                重新定制
              </Link>
            </div>
            {carriedError && (
              <div className="mt-2">
                <Banner tone="error">{carriedError}</Banner>
              </div>
            )}
          </section>
        )}

        {/* 服务状态 */}
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-700">服务状态</span>
              {healthLoading ? (
                <span className="text-xs text-slate-400">检查中…</span>
              ) : health ? (
                <>
                  <StatusChip ok={health.ok} label="服务在线" />
                  <StatusChip ok={health.hasIndeedCsrf} label="已加载会话" />
                  <StatusChip ok={health.cdpConnected} label={health.cdpConnected ? "浏览器已连接" : "浏览器未连接（投递时连）"} />
                  {health.applicant.email && (
                    <span className="text-xs text-slate-500">
                      申请人：{health.applicant.firstName} {health.applicant.lastName} ·{" "}
                      {health.applicant.email}
                    </span>
                  )}
                </>
              ) : (
                <StatusChip ok={false} label="服务离线" />
              )}
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}
            >
              {refreshing ? "重载中…" : "重载会话"}
            </button>
          </div>
          {healthError && (
            <p className="mt-2 text-xs text-amber-700">
              {healthError}
            </p>
          )}
        </section>

        {/* 搜索 */}
        <form
          onSubmit={handleSearch}
          className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_110px]">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">搜索词 *</label>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="如 software engineer"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">地点（可空）</label>
              <input
                value={l}
                onChange={(e) => setL(e.target.value)}
                placeholder="如 Remote"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">数量</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 10)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={searching || !q.trim()}
              className={`${btnBase} bg-sky-600 text-white hover:bg-sky-700`}
            >
              {searching ? "搜索中…（数量大时可能较久）" : "搜索岗位"}
            </button>
            <span className="text-xs text-slate-400">
              数量最多 1000；服务端按页抓取，数量越大越慢（上百条可能要 1–2 分钟），也更易触发反爬。
            </span>
          </div>
          {searchError && (
            <div className="mt-3">
              <Banner tone="error">{searchError}</Banner>
            </div>
          )}
        </form>

        {/* 结果 */}
        {searched && !searching && jobs.length === 0 && !searchError && (
          <Banner tone="info">没有找到岗位，换个搜索词试试。</Banner>
        )}

        {jobs.length > 0 && (
          <div className="mb-6 space-y-2">
            {jobs.map((job) => {
              const isSelected = job.jk === selectedJk;
              return (
                <div
                  key={job.jk}
                  onClick={() => job.indeedApply && selectJob(job.jk)}
                  className={`w-full rounded-xl border p-4 text-left transition ${
                    isSelected
                      ? "border-sky-400 bg-sky-50 shadow-sm"
                      : job.indeedApply
                        ? "cursor-pointer border-slate-200 bg-white hover:border-sky-300 hover:shadow-sm"
                        : "border-slate-200 bg-slate-50 opacity-70"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">{job.title || "（无标题）"}</p>
                      <p className="text-sm text-slate-500">
                        {job.company}
                        {job.location ? ` · ${job.location}` : ""}
                      </p>
                    </div>
                    {job.indeedApply ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          可一键投递
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startApplyForJob(job.jk);
                          }}
                          className={`${btnBase} bg-sky-600 px-3 py-1.5 text-white hover:bg-sky-700`}
                        >
                          {isSelected ? "投递中 ↓" : "一键投递 →"}
                        </button>
                      </div>
                    ) : (
                      <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-500">
                        不支持
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 选中岗位的投递面板 */}
        {selectedJob && (
          <section ref={panelRef} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">{selectedJob.title}</h2>
            <p className="text-sm text-slate-500">
              {selectedJob.company}
              {selectedJob.location ? ` · ${selectedJob.location}` : ""} · jk: {selectedJob.jk}
            </p>

            {/* 雇主问题（作答 + 知识库预填） */}
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">雇主问题</p>
                <button
                  type="button"
                  onClick={() => handleLoadQuestions()}
                  disabled={questionsLoading}
                  className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
                >
                  {questionsLoading ? "读取中…" : "重新读取"}
                </button>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                知识库会自动预填：<span className="text-emerald-600">精确命中</span>直接填、
                <span className="text-sky-600">相似命中</span>请你过目确认、其余需你填写。点「保存并预演」时会把答案存入知识库，下次自动作答。
              </p>
              {questionsError && (
                <div className="mt-2">
                  <Banner tone="error">{questionsError}</Banner>
                </div>
              )}
              {questionsLoading && !questions && (
                <p className="mt-3 text-xs text-slate-400">正在读取雇主问题…</p>
              )}
              {questions && questions.length === 0 && !questionsLoading && (
                <div className="mt-3">
                  <Banner tone="info">该岗位没有额外的雇主问题，可直接预演。</Banner>
                </div>
              )}
              {questions && questions.length > 0 && (
                <ul className="mt-3 space-y-3">
                  {questions.map((qq, i) => (
                    <li key={qq.id || i} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-slate-800">
                          {qq.label}{" "}
                          <span className="text-xs font-normal text-slate-400">
                            [{qq.type}
                            {qq.required ? " · 必填" : ""}]
                          </span>
                        </p>
                        <KbBadge match={matches[qq.id]} />
                      </div>
                      <div className="mt-2">
                        <AnswerInput
                          q={qq}
                          value={answers[qq.id] ?? ""}
                          onChange={(v) => setAnswer(qq.id, v)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {requiredUnanswered.length > 0 && (
                <p className="mt-2 text-xs text-amber-600">
                  还有 {requiredUnanswered.length} 道必填题未回答，回答后才能预演。
                </p>
              )}
            </div>

            {/* 两步投递 */}
            <div className="mt-6 border-t border-slate-100 pt-5">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveAndPreview}
                  disabled={previewing || savingKb || questionsLoading || requiredUnanswered.length > 0}
                  className={`${btnBase} bg-slate-800 text-white hover:bg-slate-900`}
                >
                  {savingKb
                    ? "保存答案中…"
                    : previewing
                      ? "预演中…（最长 90 秒）"
                      : questions && questions.length > 0
                        ? "① 保存答案并预演"
                        : "① 预演（不投递）"}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmApply}
                  disabled={!canConfirm}
                  className={`${btnBase} bg-rose-600 text-white hover:bg-rose-700`}
                >
                  {submitting ? "投递中…（最长 2 分钟）" : "② 确认投递（不可逆）"}
                </button>
                <button
                  type="button"
                  onClick={handleCheckApplied}
                  disabled={checkingApplied}
                  className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}
                >
                  {checkingApplied ? "复核中…" : "复核投递状态"}
                </button>
              </div>
              {!canConfirm && !submitResult && (
                <p className="mt-2 text-xs text-slate-400">
                  需先对该岗位「预演」成功，才能确认投递。
                </p>
              )}

              {previewError && (
                <div className="mt-3">
                  <Banner tone="error">{previewError}</Banner>
                </div>
              )}

              {/* 预演结果 */}
              {dryRun && previewedJk === selectedJk && (
                <div className="mt-4 space-y-3">
                  <Banner tone="success">
                    预演成功，未投递。已备好草稿并取得提交所需校验。确认无误后点「② 确认投递」。
                  </Banner>
                  {dryRun.answers.length > 0 && (
                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="mb-2 text-sm font-medium text-slate-700">将提交的答案</p>
                      <ul className="space-y-1 text-sm text-slate-600">
                        {dryRun.answers.map((a, i) => {
                          const qq = dryRun.questions.find((x) => x.id === a.questionId);
                          return (
                            <li key={a.questionId || i}>
                              <span className="text-slate-500">
                                {qq?.label ?? a.questionId}：
                              </span>
                              <span className="font-medium text-slate-800">
                                {answerLabel(qq, a.value)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {submitError && (
                <div className="mt-3">
                  <Banner tone="error">{submitError}</Banner>
                </div>
              )}
              {ambiguousSubmit && (
                <div className="mt-2">
                  <Banner tone="error">
                    ⚠️ 本次投递结果不确定（可能已在服务端完成提交）。请先点「复核投递状态」确认；
                    若显示未投递、且确需重投，请重新「① 预演」后再确认，切勿直接重复点击投递。
                  </Banner>
                </div>
              )}

              {/* 投递结果 */}
              {submitResult && (
                <div className="mt-4">
                  {submitResult.submitted ? (
                    <Banner tone="success">
                      ✅ 已成功投递！
                      {submitResult.applied ? `（Indeed 已确认；时间 ${fmtTime(submitResult.appliedMs)}）` : ""}
                      {submitResult.successPageUrl && (
                        <>
                          {" "}
                          <a
                            href={submitResult.successPageUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold underline"
                          >
                            查看确认页
                          </a>
                        </>
                      )}
                    </Banner>
                  ) : (
                    <Banner tone="error">服务未确认投递成功，请用「复核投递状态」核对。</Banner>
                  )}
                </div>
              )}

              {appliedError && (
                <div className="mt-3">
                  <Banner tone="error">{appliedError}</Banner>
                </div>
              )}
              {applied && (
                <div className="mt-3">
                  <Banner tone={applied.applied ? "success" : "info"}>
                    {applied.applied
                      ? `该岗位已投递（时间 ${fmtTime(applied.appliedMs)}）。`
                      : "该岗位尚未投递。"}
                  </Banner>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
