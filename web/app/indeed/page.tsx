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
import { PROFILE_FIELDS, emptyProfile, type ApplicantProfile } from "@/lib/indeed/profileFields";

// ---------- 类型（对齐 app/api/indeed/* 归一化后的响应） ----------

type AiConfidence = "high" | "medium" | "low";

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
  // 仅在开启 sponsorship 标注(筛选或全部标注)时有值。
  sponsorship?: string | null;
  sponsorshipEvidence?: string[];
};

type SearchData = {
  jobs: Job[];
  sponsorFilter?: string | null;
  classified?: boolean;
};

type SponsorshipQuestion = {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }> | null;
};

type SponsorshipResult = {
  jk: string;
  sponsorship: string;
  evidenceNeg: string[];
  evidencePos: string[];
  sponsorshipQuestions: SponsorshipQuestion[];
  note: string;
};

// sponsorship 立场 → 展示文案与配色。
const SPONSORSHIP_META: Record<string, { txt: string; cls: string }> = {
  no_sponsorship: { txt: "无需担保", cls: "bg-emerald-50 text-emerald-700" },
  sponsors: { txt: "提供担保", cls: "bg-sky-50 text-sky-700" },
  unknown: { txt: "担保未知", cls: "bg-slate-100 text-slate-500" },
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

// 批量投递
type BatchPhase = "idle" | "sweeping" | "review" | "submitting" | "done";
type BatchStatus = "ready" | "needsInput" | "applying" | "done" | "failed" | "read_failed";
type BatchItem = {
  job: Job;
  questions: Question[];
  matches: Record<string, KbMatch>;
  answers: Record<string, string>;
  aiConf: Record<string, AiConfidence>; // AI 兜底作答的题 → 置信度(用于清单里标注/高亮)
  status: BatchStatus;
  message?: string;
};

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmtTime(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString("zh-CN");
  } catch {
    return String(ms);
  }
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

/** sponsorship 立场徽章（仅在标注后有值）。 */
function SponsorshipBadge({ stance }: { stance: string | null | undefined }) {
  if (!stance) return null;
  const meta = SPONSORSHIP_META[stance] ?? SPONSORSHIP_META.unknown;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.txt}
    </span>
  );
}

/** 答案来源徽章：知识库精确/相似 → AI(按置信度) → 需你填写。 */
function AnswerSourceBadge({ match, ai }: { match: KbMatch | undefined; ai?: AiConfidence }) {
  if (match?.source === "exact") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        知识库 · 自动
      </span>
    );
  }
  if (match?.source === "similar") {
    return (
      <span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
        类似 · 请确认（{Math.round(match.confidence * 100)}%）
      </span>
    );
  }
  if (ai) {
    const cls =
      ai === "low"
        ? "bg-rose-50 text-rose-700"
        : ai === "medium"
          ? "bg-violet-50 text-violet-700"
          : "bg-violet-50 text-violet-600";
    const suffix = ai === "high" ? "" : ai === "medium" ? " · 推断" : " · 低把握请确认";
    return (
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>AI{suffix}</span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      需你填写
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

/** 批量投递里单个岗位的状态徽章。 */
function BatchStatusChip({ it }: { it: BatchItem }) {
  const map: Record<BatchStatus, { cls: string; txt: string }> = {
    ready: { cls: "bg-slate-100 text-slate-500", txt: "待投" },
    needsInput: { cls: "bg-amber-100 text-amber-700", txt: "待回答" },
    applying: { cls: "bg-sky-100 text-sky-700", txt: "投递中…" },
    done: { cls: "bg-emerald-100 text-emerald-700", txt: it.message || "已投递" },
    failed: { cls: "bg-rose-100 text-rose-700", txt: it.message || "失败" },
    read_failed: { cls: "bg-amber-100 text-amber-700", txt: "读取失败" },
  };
  const s = map[it.status];
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.txt}</span>
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
  // 担保筛选：""=不限(不判定,最快)｜no=只看不需担保｜yes=只看提供担保｜all=全部并标注担保。
  const [sponsorFilter, setSponsorFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [searched, setSearched] = useState(false);

  const [selectedJk, setSelectedJk] = useState<string | null>(null);

  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);

  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 投递超时/非 JSON：结果不确定（可能已提交），需先复核再决定是否重投。
  const [ambiguousSubmit, setAmbiguousSubmit] = useState(false);

  const [applied, setApplied] = useState<AppliedResult | null>(null);
  const [checkingApplied, setCheckingApplied] = useState(false);
  const [appliedError, setAppliedError] = useState<string | null>(null);

  // 单岗 sponsorship 立场查询（含筛选题强证据）。
  const [sponsorship, setSponsorship] = useState<SponsorshipResult | null>(null);
  const [sponsorshipLoading, setSponsorshipLoading] = useState(false);
  const [sponsorshipError, setSponsorshipError] = useState<string | null>(null);

  // 从求职神器带入的定制简历（客户端交接，见 lib/job-hunter/handoff）。
  const [carried, setCarried] = useState<ResumeHandoff | null>(null);
  const [carriedDownloading, setCarriedDownloading] = useState<ResumeExportKind | null>(null);
  const [carriedError, setCarriedError] = useState<string | null>(null);

  // 雇主问题作答 + 知识库预填
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Record<string, KbMatch>>({});
  const [aiConf, setAiConf] = useState<Record<string, AiConfidence>>({}); // 单卡:AI 兜底题的置信度
  const [aiFilling, setAiFilling] = useState(false);
  const [savingKb, setSavingKb] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  // 批量投递
  const [batchPhase, setBatchPhase] = useState<BatchPhase>("idle");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchSweep, setBatchSweep] = useState({ done: 0, total: 0 });
  const batchCancelRef = useRef(false);

  // 求职身份档案(AI 作答依据)
  const [profile, setProfile] = useState<ApplicantProfile>(emptyProfile());
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const selectedJob = jobs.find((j) => j.jk === selectedJk) ?? null;

  // 挂载时读取带入的定制简历；若搜索词为空，用简历标题预填，方便直接搜岗位。
  useEffect(() => {
    const h = readHandoff();
    if (!h) return;
    setCarried(h);
    setQ((prev) => prev || h.result.resume.headline || "");
  }, []);

  // 挂载时载入身份档案(AI 作答依据)。
  useEffect(() => {
    void (async () => {
      const res = await callApi<ApplicantProfile>("/api/indeed/profile");
      if (res.success && res.data) setProfile((prev) => ({ ...prev, ...res.data }));
    })();
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
    setSubmitResult(null);
    setSubmitError(null);
    setAmbiguousSubmit(false);
    setApplied(null);
    setAppliedError(null);
    setSponsorship(null);
    setSponsorshipError(null);
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
    // 担保筛选：no/yes 交给 sponsor（服务自动标注）；all 只标注不过滤（classify=1）。
    if (sponsorFilter === "no" || sponsorFilter === "yes") params.set("sponsor", sponsorFilter);
    else if (sponsorFilter === "all") params.set("classify", "1");
    const res = await callApi<SearchData>(`/api/indeed/search?${params.toString()}`);
    if (res.success && res.data) setJobs(res.data.jobs);
    else {
      setJobs([]);
      setSearchError(res.error ?? "搜索失败。");
    }
    setSearching(false);
  }

  function carriedResumeSummary(): string | undefined {
    if (!carried) return undefined;
    const r = carried.result.resume;
    const txt = [r.headline, ...(r.summary ?? [])].filter(Boolean).join("\n").trim();
    return txt ? txt.slice(0, 3000) : undefined;
  }

  /** 用 AI 回答给定问题(知识库未覆盖的题);返回 qid -> {value, confidence}。 */
  async function aiAnswerFor(
    qs: Question[],
    job?: { title?: string; company?: string },
  ): Promise<Record<string, { value: string; confidence: AiConfidence }>> {
    if (!qs.length) return {};
    const res = await callApi<{ answers: Record<string, { value: string; confidence: AiConfidence }> }>(
      "/api/indeed/ai-answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: qs.map((q) => ({
            id: q.id,
            type: q.type,
            required: q.required,
            label: q.label,
            options: q.options,
          })),
          jobTitle: job?.title,
          company: job?.company,
          resume: carriedResumeSummary(),
        }),
      },
    );
    return res.success && res.data?.answers ? res.data.answers : {};
  }

  async function handleSaveProfile() {
    setProfileSaving(true);
    setProfileMsg(null);
    const res = await callApi<ApplicantProfile>("/api/indeed/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    if (res.success && res.data) {
      setProfile((prev) => ({ ...prev, ...res.data }));
      setProfileMsg("已保存");
    } else {
      setProfileMsg(res.error ?? "保存失败");
    }
    setProfileSaving(false);
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
      const qs = res.data.questions;
      setQuestions(qs);
      const m = res.data.matches ?? {};
      setMatches(m);
      // 用知识库命中预填答案(精确+相似都预填;相似会在 UI 标注请你确认)。
      const init: Record<string, string> = {};
      for (const qq of qs) {
        const hit = m[qq.id];
        if (hit) init[qq.id] = hit.value;
      }
      setAnswers(init);
      setAiConf({});
      setQuestionsLoading(false);
      // 全自动:知识库未覆盖的题交给 AI 兜底作答(不阻塞问题展示)。
      const uncovered = qs.filter((q) => !(init[q.id] ?? "").trim());
      if (uncovered.length) {
        const job = jobs.find((j) => j.jk === jk);
        setAiFilling(true);
        const ai = await aiAnswerFor(uncovered, { title: job?.title, company: job?.company });
        setAnswers((prev) => {
          const next = { ...prev };
          for (const [id, a] of Object.entries(ai)) if (!(next[id] ?? "").trim() && a.value) next[id] = a.value;
          return next;
        });
        setAiConf((prev) => {
          const next = { ...prev };
          for (const [id, a] of Object.entries(ai)) if (a.value) next[id] = a.confidence;
          return next;
        });
        setAiFilling(false);
      }
    } else {
      setQuestionsError(res.error ?? "读取雇主问题失败。");
      setQuestionsLoading(false);
    }
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


  // ---------- 批量投递 ----------

  function batchRequiredUnanswered(it: BatchItem): boolean {
    return it.questions.some((q) => q.required && !(it.answers[q.id] ?? "").toString().trim());
  }

  function batchAnswersPayload(it: BatchItem): Answer[] {
    return it.questions
      .map((q) => ({ questionId: q.id, value: (it.answers[q.id] ?? "").toString() }))
      .filter((a) => a.questionId && a.value.trim().length > 0);
  }

  function batchKbItems(it: BatchItem) {
    return it.questions
      .map((q) => {
        const value = (it.answers[q.id] ?? "").toString();
        const valueLabel = q.options?.find((o) => o.value === value)?.label ?? null;
        return { label: q.label, type: q.type, options: q.options, value, valueLabel };
      })
      .filter((x) => x.value.trim().length > 0);
  }

  /** 扫描当前结果里所有「可投」岗位:逐个取问题 + 知识库预填,判定是否需要你介入。 */
  async function startBatch() {
    const targets = jobs.filter((j) => j.indeedApply);
    if (!targets.length || batchPhase === "sweeping" || batchPhase === "submitting") return;
    setSelectedJk(null); // 收起单卡面板,避免干扰
    setBatchItems([]);
    setBatchSweep({ done: 0, total: targets.length });
    setBatchPhase("sweeping");
    batchCancelRef.current = false;
    const items: BatchItem[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (batchCancelRef.current) break;
      const job = targets[i];
      const res = await callApi<{ questions: Question[]; matches?: Record<string, KbMatch> }>(
        `/api/indeed/questions?jk=${encodeURIComponent(job.jk)}`,
      );
      if (res.success && res.data) {
        const qs = res.data.questions;
        const m = res.data.matches ?? {};
        const ans: Record<string, string> = {};
        for (const q of qs) {
          const hit = m[q.id];
          if (hit) ans[q.id] = hit.value;
        }
        // 全自动:知识库未覆盖的题用 AI 兜底,尽量让整卡就绪。
        const aiConf: Record<string, AiConfidence> = {};
        const uncovered = qs.filter((q) => !(ans[q.id] ?? "").trim());
        if (uncovered.length) {
          const ai = await aiAnswerFor(uncovered, { title: job.title, company: job.company });
          for (const [id, a] of Object.entries(ai)) {
            if (a.value && !(ans[id] ?? "").trim()) {
              ans[id] = a.value;
              aiConf[id] = a.confidence;
            }
          }
        }
        const needs = qs.some((q) => q.required && !(ans[q.id] ?? "").trim());
        items.push({ job, questions: qs, matches: m, answers: ans, aiConf, status: needs ? "needsInput" : "ready" });
      } else {
        items.push({ job, questions: [], matches: {}, answers: {}, aiConf: {}, status: "read_failed", message: res.error ?? "读取问题失败" });
      }
      setBatchSweep({ done: i + 1, total: targets.length });
      setBatchItems([...items]);
      await sleep(400); // 轻限流,减轻限流器与 Indeed 反爬压力
    }
    setBatchPhase(batchCancelRef.current ? "idle" : "review");
  }

  /** review 阶段编辑某岗位的答案;答齐必填后该岗位自动从 needsInput 变 ready。 */
  function setBatchAnswer(jk: string, qid: string, value: string) {
    setBatchItems((prev) =>
      prev.map((it) => {
        if (it.job.jk !== jk) return it;
        if (it.status === "read_failed") return it;
        const answers = { ...it.answers, [qid]: value };
        const aiConf = { ...it.aiConf };
        delete aiConf[qid]; // 用户手改后不再是 AI 答案
        const needs = it.questions.some((q) => q.required && !(answers[q.id] ?? "").trim());
        return { ...it, answers, aiConf, status: needs ? "needsInput" : "ready" };
      }),
    );
  }

  /** 展示清单后的一次总确认 → 逐个真实提交(可中止)。只投 ready 的,needsInput/failed 跳过。 */
  async function confirmBatch() {
    const submittable = batchItems.filter((it) => it.status === "ready");
    if (!submittable.length) return;
    const ok = window.confirm(
      `将真实投递 ${submittable.length} 个岗位,不可逆、无法撤回。确定继续?`,
    );
    if (!ok) return;
    setBatchPhase("submitting");
    batchCancelRef.current = false;
    for (const it of submittable) {
      if (batchCancelRef.current) break;
      setBatchItems((prev) =>
        prev.map((x) => (x.job.jk === it.job.jk ? { ...x, status: "applying" } : x)),
      );
      const kb = batchKbItems(it);
      if (kb.length) {
        await callApi("/api/indeed/kb/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: kb }),
        });
      }
      const res = await callApi<SubmitResult>("/api/indeed/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jk: it.job.jk, confirm: true, answers: batchAnswersPayload(it) }),
      });
      const okSubmit = res.success && res.data?.submitted === true;
      setBatchItems((prev) =>
        prev.map((x) =>
          x.job.jk === it.job.jk
            ? {
                ...x,
                status: okSubmit ? "done" : "failed",
                message: okSubmit
                  ? res.data?.applied
                    ? `已投递（已确认 ${fmtTime(res.data.appliedMs)}）`
                    : "已提交"
                  : res.error ?? "投递失败",
              }
            : x,
        ),
      );
      await sleep(500);
    }
    setBatchPhase("done");
  }

  function cancelBatch() {
    batchCancelRef.current = true;
    if (batchPhase === "review") setBatchPhase("idle");
  }

  function closeBatch() {
    if (batchPhase === "sweeping" || batchPhase === "submitting") return;
    setBatchPhase("idle");
    setBatchItems([]);
  }

  /** 一键直投:必填答齐即可直接提交,不再两步预演(仍保留一次不可逆确认 + 超时歧义保护)。 */
  async function handleApplyDirect() {
    if (!selectedJk || submitting || savingKb) return;
    if (requiredUnanswered.length > 0) return; // 必填未答:先在下方表单填完
    const ok = window.confirm(
      `确认向雇主真实投递该岗位？\n\n${selectedJob?.title ?? ""} · ${selectedJob?.company ?? ""}\n\n此操作不可逆，将以本地服务登录的身份提交申请。`,
    );
    if (!ok) return;
    setSubmitError(null);
    setSubmitResult(null);
    setAmbiguousSubmit(false);
    await saveAnswersToKb(); // 尽力而为:入库失败不阻断投递
    setSubmitting(true);
    const res = await callApi<SubmitResult>("/api/indeed/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jk: selectedJk, confirm: true, answers: answersPayload() }),
    });
    if (res.success && res.data) {
      setSubmitResult(res.data);
    } else {
      setSubmitError(res.error ?? "投递失败。");
      // 超时/非 JSON:本次「可能」已在服务端完成,先复核再决定是否重投;仅「连不上」是确定没投。
      if (res.code !== "connection") setAmbiguousSubmit(true);
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

  /** 查该岗位的 visa 担保立场（questions=1 额外拉雇主筛选题作强证据）。 */
  async function handleCheckSponsorship() {
    if (!selectedJk || sponsorshipLoading) return;
    setSponsorshipLoading(true);
    setSponsorshipError(null);
    const res = await callApi<SponsorshipResult>(
      `/api/indeed/sponsorship?jk=${encodeURIComponent(selectedJk)}&questions=1`,
    );
    if (res.success && res.data) setSponsorship(res.data);
    else setSponsorshipError(res.error ?? "判定担保立场失败。");
    setSponsorshipLoading(false);
  }

  const alreadyApplied = submitResult?.jk === selectedJk && submitResult?.submitted === true;

  const applyableCount = jobs.filter((j) => j.indeedApply).length;
  const batchReady = batchItems.filter((it) => it.status === "ready").length;
  const batchNeeds = batchItems.filter((it) => it.status === "needsInput").length;
  const batchReadFailed = batchItems.filter((it) => it.status === "read_failed").length;
  const batchDoneCount = batchItems.filter((it) => it.status === "done").length;
  const batchSubmitFailed = batchItems.filter((it) => it.status === "failed").length;
  const batchSubmitList = batchItems.filter((it) =>
    ["ready", "applying", "done", "failed"].includes(it.status),
  );
  const batchLowConf = batchItems
    .filter((it) => it.status === "ready")
    .reduce((n, it) => n + Object.values(it.aiConf).filter((c) => c === "low").length, 0);

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
            搜索岗位（可按签证担保筛选）→ 答齐雇主问题（知识库自动预填）→ 一键真实投递 → 复核状态。
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

        {/* 求职身份档案（AI 作答依据） */}
        <details
          open={profileOpen}
          onToggle={(e) => setProfileOpen((e.target as HTMLDetailsElement).open)}
          className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            求职身份档案（AI 据此如实作答雇主问题；填一次即可，随时可改）
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map((f) => (
              <label key={f.key} className={f.long ? "sm:col-span-2" : undefined}>
                <span className="mb-1 block text-xs font-medium text-slate-500">{f.label}</span>
                {f.long ? (
                  <textarea
                    value={profile[f.key]}
                    onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
                  />
                ) : (
                  <input
                    value={profile[f.key]}
                    onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400"
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveProfile}
              disabled={profileSaving}
              className={`${btnBase} bg-sky-600 text-white hover:bg-sky-700`}
            >
              {profileSaving ? "保存中…" : "保存档案"}
            </button>
            {profileMsg && <span className="text-xs text-slate-500">{profileMsg}</span>}
            <span className="text-xs text-slate-400">
              留空的字段 AI 会尽量从简历/岗位推断；工作授权、sponsorship 等硬事实建议填准。
            </span>
          </div>
        </details>

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
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-slate-500">签证担保（sponsorship）</label>
            <select
              value={sponsorFilter}
              onChange={(e) => setSponsorFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-400 sm:max-w-xs"
            >
              <option value="">不限（不判定，最快）</option>
              <option value="no">只看「不需担保」的岗位</option>
              <option value="yes">只看「提供担保」的岗位</option>
              <option value="all">全部并标注担保立场</option>
            </select>
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
              {sponsorFilter && "（担保判定需逐岗抓描述，会明显更慢）"}
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

        {/* 批量投递入口 */}
        {batchPhase === "idle" && jobs.length > 0 && applyableCount > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50/50 p-3">
            <p className="text-sm text-rose-800">
              批量投递：一键投递当前结果里全部 {applyableCount} 个可投岗位。无雇主问题 / 知识库能答全的自动投，答不全的先让你回答。
              <span className="font-medium">真实提交、不可逆。</span>
            </p>
            <button
              type="button"
              onClick={startBatch}
              className={`${btnBase} shrink-0 bg-rose-600 text-white hover:bg-rose-700`}
            >
              一键全部投递（{applyableCount}）
            </button>
          </div>
        )}

        {/* 批量投递面板 */}
        {batchPhase !== "idle" && (
          <section className="mb-6 rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">批量投递</h2>
              {(batchPhase === "review" || batchPhase === "done") && (
                <button
                  type="button"
                  onClick={closeBatch}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  关闭
                </button>
              )}
            </div>

            {batchPhase === "sweeping" && (
              <div className="mt-3">
                <p className="text-sm text-slate-600">
                  正在扫描岗位、匹配知识库并用 AI 兜底作答…（{batchSweep.done}/{batchSweep.total}）
                </p>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{ width: `${batchSweep.total ? (batchSweep.done / batchSweep.total) * 100 : 0}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={cancelBatch}
                  className={`${btnBase} mt-3 bg-slate-100 text-slate-700 hover:bg-slate-200`}
                >
                  中止扫描
                </button>
              </div>
            )}

            {batchPhase === "review" && (
              <div className="mt-3 space-y-4">
                <Banner tone="error">
                  将真实投递 <span className="font-semibold">{batchReady}</span> 个岗位，
                  <span className="font-semibold">不可逆、无法撤回</span>。
                  {batchNeeds > 0 && <> 另有 {batchNeeds} 个待你回答（答齐才计入）。</>}
                  {batchReadFailed > 0 && <> {batchReadFailed} 个读取失败将跳过。</>}
                  {batchLowConf > 0 && (
                    <> 其中 AI <span className="font-semibold">{batchLowConf}</span> 处低把握，建议展开「已就绪」复核。</>
                  )}{" "}
                  每个约 1–2 分钟且串行，预计 {batchReady}–{batchReady * 2} 分钟，可随时中止。
                </Banner>

                {batchNeeds > 0 && (
                  <div>
                    <p className="text-sm font-semibold text-slate-800">需要你回答（{batchNeeds}）</p>
                    <ul className="mt-2 space-y-3">
                      {batchItems
                        .filter((it) => it.status === "needsInput")
                        .map((it) => (
                          <li key={it.job.jk} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                            <p className="text-sm font-medium text-slate-900">{it.job.title}</p>
                            <p className="text-xs text-slate-500">
                              {it.job.company}
                              {it.job.location ? ` · ${it.job.location}` : ""}
                            </p>
                            <ul className="mt-2 space-y-2">
                              {it.questions.map((qq, i) => (
                                <li key={qq.id || i} className="rounded-md border border-slate-200 bg-white p-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-xs font-medium text-slate-700">
                                      {qq.label}{" "}
                                      <span className="font-normal text-slate-400">
                                        [{qq.type}
                                        {qq.required ? " · 必填" : ""}]
                                      </span>
                                    </p>
                                    <AnswerSourceBadge match={it.matches[qq.id]} ai={it.aiConf[qq.id]} />
                                  </div>
                                  <div className="mt-1.5">
                                    <AnswerInput
                                      q={qq}
                                      value={it.answers[qq.id] ?? ""}
                                      onChange={(v) => setBatchAnswer(it.job.jk, qq.id, v)}
                                    />
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {batchReady > 0 && (
                  <details className="rounded-lg border border-slate-200 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                      已就绪 · 将投递（{batchReady}）
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {batchItems
                        .filter((it) => it.status === "ready")
                        .map((it) => {
                          const aiN = Object.keys(it.aiConf).length;
                          const lowN = Object.values(it.aiConf).filter((c) => c === "low").length;
                          return (
                            <li key={it.job.jk}>
                              {it.job.title} · {it.job.company}
                              {it.questions.length > 0 && (
                                <span className="text-slate-400">
                                  （{batchAnswersPayload(it).length} 题已答
                                  {aiN > 0 ? ` · AI ${aiN}` : ""}
                                  {lowN > 0 ? (
                                    <span className="font-medium text-rose-600"> · {lowN} 低把握</span>
                                  ) : (
                                    ""
                                  )}
                                  ）
                                </span>
                              )}
                            </li>
                          );
                        })}
                    </ul>
                  </details>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={confirmBatch}
                    disabled={batchReady === 0}
                    className={`${btnBase} bg-rose-600 text-white hover:bg-rose-700`}
                  >
                    确认全部投递（{batchReady}）
                  </button>
                  <button
                    type="button"
                    onClick={cancelBatch}
                    className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}
                  >
                    取消
                  </button>
                  {batchNeeds > 0 && (
                    <span className="text-xs text-amber-600">还有 {batchNeeds} 个未答，将不会被投递。</span>
                  )}
                </div>
              </div>
            )}

            {(batchPhase === "submitting" || batchPhase === "done") && (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-slate-600">
                  {batchPhase === "submitting"
                    ? `正在逐个投递…（成功 ${batchDoneCount} / 失败 ${batchSubmitFailed}，共 ${batchSubmitList.length}）`
                    : `完成：成功 ${batchDoneCount} 个，失败 ${batchSubmitFailed} 个${batchReadFailed ? `，读取失败跳过 ${batchReadFailed} 个` : ""}。`}
                </p>
                <ul className="max-h-80 space-y-1.5 overflow-y-auto">
                  {batchSubmitList.map((it) => (
                    <li
                      key={it.job.jk}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-200 p-2 text-xs"
                    >
                      <span className="truncate text-slate-700">
                        {it.job.title} · {it.job.company}
                      </span>
                      <BatchStatusChip it={it} />
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3">
                  {batchPhase === "submitting" && (
                    <button
                      type="button"
                      onClick={cancelBatch}
                      className={`${btnBase} bg-slate-100 text-slate-700 hover:bg-slate-200`}
                    >
                      中止（完成当前后停止）
                    </button>
                  )}
                  {batchPhase === "done" && (
                    <button
                      type="button"
                      onClick={closeBatch}
                      className={`${btnBase} bg-slate-800 text-white hover:bg-slate-900`}
                    >
                      关闭
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
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
                        <SponsorshipBadge stance={job.sponsorship} />
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
                      <div className="flex shrink-0 items-center gap-2">
                        <SponsorshipBadge stance={job.sponsorship} />
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-500">
                          不支持
                        </span>
                      </div>
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

            {/* 签证担保立场（visa sponsorship） */}
            <div className="mt-4 rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">签证担保立场</span>
                  {sponsorship && <SponsorshipBadge stance={sponsorship.sponsorship} />}
                </div>
                <button
                  type="button"
                  onClick={handleCheckSponsorship}
                  disabled={sponsorshipLoading}
                  className="text-xs text-sky-600 hover:text-sky-700 disabled:opacity-50"
                >
                  {sponsorshipLoading ? "判定中…" : sponsorship ? "重新判定" : "查担保立场（含筛选题）"}
                </button>
              </div>
              {sponsorshipError && (
                <div className="mt-2">
                  <Banner tone="error">{sponsorshipError}</Banner>
                </div>
              )}
              {sponsorship && (
                <div className="mt-2 space-y-1.5 text-xs text-slate-600">
                  {sponsorship.evidenceNeg.length > 0 && (
                    <p>
                      <span className="text-emerald-700">不需担保证据：</span>
                      {sponsorship.evidenceNeg.join("；")}
                    </p>
                  )}
                  {sponsorship.evidencePos.length > 0 && (
                    <p>
                      <span className="text-sky-700">提供担保证据：</span>
                      {sponsorship.evidencePos.join("；")}
                    </p>
                  )}
                  {sponsorship.sponsorshipQuestions.length > 0 && (
                    <div>
                      <span className="text-slate-500">相关筛选题：</span>
                      <ul className="ml-4 list-disc">
                        {sponsorship.sponsorshipQuestions.map((sq, i) => (
                          <li key={sq.id || i}>{sq.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {sponsorship.note && <p className="text-slate-400">{sponsorship.note}</p>}
                </div>
              )}
            </div>

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
                <span className="text-sky-600">相似命中</span>请你过目确认；知识库没有的题由 <span className="text-violet-600">AI</span> 依据你的身份档案兜底作答（
                <span className="text-rose-600">低把握</span>会标出请你复核）。点「一键投递」时会把答案存入知识库，下次自动作答。
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
              {aiFilling && (
                <p className="mt-3 text-xs text-violet-500">AI 正在补全知识库未覆盖的问题…</p>
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
                        <AnswerSourceBadge match={matches[qq.id]} ai={aiConf[qq.id]} />
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

            {/* 一键直投 */}
            <div className="mt-6 border-t border-slate-100 pt-5">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleApplyDirect}
                  disabled={
                    submitting ||
                    savingKb ||
                    questionsLoading ||
                    requiredUnanswered.length > 0 ||
                    alreadyApplied
                  }
                  className={`${btnBase} bg-rose-600 text-white hover:bg-rose-700`}
                >
                  {submitting
                    ? "投递中…"
                    : savingKb
                      ? "保存答案中…"
                      : alreadyApplied
                        ? "已投递 ✓"
                        : "一键投递（不可逆）"}
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
              {requiredUnanswered.length > 0 ? (
                <p className="mt-2 text-xs text-amber-600">
                  有 {requiredUnanswered.length} 个必填问题未回答，填完即可直接投递。
                </p>
              ) : (
                !submitResult && (
                  <p className="mt-2 text-xs text-slate-400">
                    该岗位已就绪，点「一键投递」即直接提交（不可逆，无需预演）。
                  </p>
                )
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
                    若显示未投递、且确需重投，再点「一键投递」，切勿在未复核前重复点击。
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
