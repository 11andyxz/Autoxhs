"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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

  const selectedJob = jobs.find((j) => j.jk === selectedJk) ?? null;

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

  function resetSelectionState() {
    setQuestions(null);
    setQuestionsError(null);
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

  async function handleLoadQuestions() {
    if (!selectedJk || questionsLoading) return;
    setQuestionsLoading(true);
    setQuestionsError(null);
    const res = await callApi<{ questions: Question[] }>(
      `/api/indeed/questions?jk=${encodeURIComponent(selectedJk)}`,
    );
    if (res.success && res.data) setQuestions(res.data.questions);
    else setQuestionsError(res.error ?? "读取雇主问题失败。");
    setQuestionsLoading(false);
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
      body: JSON.stringify({ jk: selectedJk, confirm: false }),
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
      body: JSON.stringify({ jk: selectedJk, confirm: true }),
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
                max={30}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 10)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
              />
            </div>
          </div>
          <div className="mt-3">
            <button
              type="submit"
              disabled={searching || !q.trim()}
              className={`${btnBase} bg-sky-600 text-white hover:bg-sky-700`}
            >
              {searching ? "搜索中…" : "搜索岗位"}
            </button>
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
                <button
                  key={job.jk}
                  type="button"
                  onClick={() => job.indeedApply && selectJob(job.jk)}
                  disabled={!job.indeedApply}
                  className={`w-full rounded-xl border p-4 text-left transition ${
                    isSelected
                      ? "border-sky-400 bg-sky-50 shadow-sm"
                      : job.indeedApply
                        ? "border-slate-200 bg-white hover:border-sky-300 hover:shadow-sm"
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
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        可一键投递
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-500">
                        不支持
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 选中岗位的投递面板 */}
        {selectedJob && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">{selectedJob.title}</h2>
            <p className="text-sm text-slate-500">
              {selectedJob.company}
              {selectedJob.location ? ` · ${selectedJob.location}` : ""} · jk: {selectedJob.jk}
            </p>

            {/* 雇主问题（只读） */}
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLoadQuestions}
                  disabled={questionsLoading}
                  className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}
                >
                  {questionsLoading ? "读取中…" : "查看雇主问题"}
                </button>
                <span className="text-xs text-slate-400">
                  自动答案由本地服务按默认策略生成，仅供查看，不可在此编辑。
                </span>
              </div>
              {questionsError && (
                <div className="mt-2">
                  <Banner tone="error">{questionsError}</Banner>
                </div>
              )}
              {questions && (
                <div className="mt-3">
                  {questions.length === 0 ? (
                    <Banner tone="info">该岗位没有额外的雇主问题。</Banner>
                  ) : (
                    <ul className="space-y-2">
                      {questions.map((qq, i) => (
                        <li key={qq.id || i} className="rounded-lg border border-slate-200 p-3 text-sm">
                          <p className="font-medium text-slate-800">
                            {qq.label}{" "}
                            <span className="text-xs font-normal text-slate-400">
                              [{qq.type}
                              {qq.required ? " · 必填" : ""}]
                            </span>
                          </p>
                          <p className="mt-1 text-slate-600">
                            自动答案：
                            <span className="font-medium text-sky-700">
                              {answerLabel(qq, qq.autoAnswer ?? "")}
                            </span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* 两步投递 */}
            <div className="mt-6 border-t border-slate-100 pt-5">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewing}
                  className={`${btnBase} bg-slate-800 text-white hover:bg-slate-900`}
                >
                  {previewing ? "预演中…（最长 90 秒）" : "① 预演（不投递）"}
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
