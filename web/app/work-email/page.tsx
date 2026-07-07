"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { renderEmailHtml } from "@/lib/workEmail/render";
import { defaultTargetWeek, detectNextWeekFromText } from "@/lib/workEmail/week";
import type { Recipient } from "@/lib/workEmail/recipients";

const LOADING_HINTS = [
  "正在解读上一封工作邮件……",
  "正在规划这一周的工作重点……",
  "正在起草邮件正文……",
];

const ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type SourceMode = "file" | "text";

interface Draft {
  subject: string;
  body: string;
}

interface SendResult {
  from: string;
  to: string;
  cc: string[];
}

export default function WorkEmailPage() {
  // 上一封邮件输入
  const [priorMode, setPriorMode] = useState<SourceMode>("file");
  const [priorFile, setPriorFile] = useState<File | null>(null);
  const [priorText, setPriorText] = useState("");

  // 收件人（从数据库加载 + 可自定义）
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [gmailConfigured, setGmailConfigured] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(""); // 雇员 id 字符串 或 "custom"
  const [customName, setCustomName] = useState("");
  const [customEmail, setCustomEmail] = useState("");

  const [targetWeek, setTargetWeek] = useState("");
  const [weekNote, setWeekNote] = useState<string | null>(null);
  const weekTouchedRef = useRef(false); // 用户是否手动改过目标周(改过就不再自动覆盖)

  // 生成
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hintIndex, setHintIndex] = useState(0);

  // 草稿（可编辑）+ 发送
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [hasDraft, setHasDraft] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);

  const draftRef = useRef<HTMLDivElement | null>(null);

  // 预填目标周（在 effect 里做，避免 SSR/CSR 时间不一致的水合告警）
  useEffect(() => {
    setTargetWeek(defaultTargetWeek());
  }, []);

  // 载入收件人（雇员库）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/work-email/recipients");
        const json = (await res.json().catch(() => null)) as
          | { success?: boolean; recipients?: Recipient[]; gmailConfigured?: boolean }
          | null;
        if (!alive) return;
        if (json?.success && Array.isArray(json.recipients)) {
          setRecipients(json.recipients);
          setSelectedId(json.recipients.length ? String(json.recipients[0].id) : "custom");
        } else {
          setSelectedId("custom");
        }
        setGmailConfigured(json?.gmailConfigured !== false);
      } catch {
        if (alive) setSelectedId("custom");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!loading) {
      setHintIndex(0);
      return;
    }
    const id = setInterval(() => {
      setHintIndex((i) => (i + 1) % LOADING_HINTS.length);
    }, 1800);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (hasDraft && draftRef.current) {
      draftRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hasDraft]);

  // 发送成功后若又改了主题/正文/收件人/CC,清掉「已发送」状态:重新显示发送按钮,
  // 并撤下已过期的成功提示(否则会卡在无法再次发送、且信息与编辑不符的死角)。
  useEffect(() => {
    setSent(null);
    setSendError(null);
  }, [subject, body, cc, selectedId, customEmail, customName]);

  const selectedRecipient = useMemo(
    () => recipients.find((r) => String(r.id) === selectedId) ?? null,
    [recipients, selectedId],
  );
  const isCustom = selectedId === "custom";
  const recipientName = isCustom ? customName.trim() : selectedRecipient?.name ?? "";
  const toEmail = isCustom ? customEmail.trim() : selectedRecipient?.email ?? "";

  const previewHtml = useMemo(() => renderEmailHtml(body), [body]);
  const ccList = useMemo(
    () =>
      cc
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [cc],
  );

  // 上传文件后:让服务端解析出上一封邮件覆盖的周,自动把「目标周」填成它的下一周。
  async function detectWeekFromFile(file: File) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/work-email/detect-week", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; targetWeek?: string | null }
        | null;
      if (json?.success && json.targetWeek && !weekTouchedRef.current) {
        setTargetWeek(json.targetWeek);
        setWeekNote("已根据上一封邮件自动识别");
      }
    } catch {
      /* 识别失败就保留默认目标周,不打扰用户 */
    }
  }

  function handlePriorFile(f: File | null) {
    setPriorFile(f);
    setWeekNote(null);
    if (f) detectWeekFromFile(f);
  }

  // 粘贴文本时在前端直接识别(文本已在手,无需再请求服务端)。
  function handlePriorText(v: string) {
    setPriorText(v);
    if (!weekTouchedRef.current) {
      const detected = detectNextWeekFromText(v, new Date().getFullYear());
      if (detected) {
        setTargetWeek(detected);
        setWeekNote("已根据粘贴内容自动识别");
      }
    }
  }

  function validateGenerate(): string | null {
    if (priorMode === "file" ? !priorFile : !priorText.trim()) {
      return "请提供上一封工作邮件（上传 PDF / DOCX 或粘贴文本）。";
    }
    if (isCustom && !recipientName) {
      return "请填写收件人姓名（用于邮件问候语）。";
    }
    return null;
  }

  async function handleGenerate() {
    const v = validateGenerate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setSendError(null);
    setSent(null);
    setConfirming(false);
    setHasDraft(false);
    setLoading(true);

    const fd = new FormData();
    if (priorMode === "file" && priorFile) fd.append("file", priorFile);
    else fd.append("priorText", priorText);
    fd.append("recipientName", recipientName);
    fd.append("targetWeek", targetWeek);

    try {
      const res = await fetch("/api/work-email/generate", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; draft?: Draft; error?: string }
        | null;
      if (!res.ok || !json?.success || !json.draft) {
        setError(json?.error || "生成失败，请稍后重试。");
        return;
      }
      setSubject(json.draft.subject);
      setBody(json.draft.body);
      setHasDraft(true);
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function isValidEmail(s: string): boolean {
    // 与服务端一致:不接受逗号/尖括号/引号等会被拆成多个收件人的字符
    return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s.trim());
  }

  function handleClickSend() {
    setSendError(null);
    if (!toEmail || !isValidEmail(toEmail)) {
      setSendError("请先选择或填写有效的收件人邮箱。");
      return;
    }
    if (!subject.trim()) {
      setSendError("请填写邮件主题。");
      return;
    }
    if (!body.trim()) {
      setSendError("邮件正文不能为空。");
      return;
    }
    const badCc = ccList.find((c) => !isValidEmail(c));
    if (badCc) {
      setSendError(`抄送邮箱「${badCc}」格式不正确。`);
      return;
    }
    setConfirming(true);
  }

  async function handleConfirmSend() {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/work-email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: toEmail,
          cc: ccList,
          subject: subject.trim(),
          body,
          // 选自雇员库时带上 employeeId,让这封邮件记到该雇员名下(自定义收件人则为 null)
          employeeId: isCustom ? null : selectedRecipient?.id ?? null,
          recipientName,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; result?: SendResult; error?: string }
        | null;
      if (!res.ok || !json?.success || !json.result) {
        setSendError(json?.error || "发送失败，请稍后重试。");
        return;
      }
      setSent(json.result);
      setConfirming(false);
    } catch {
      setSendError("网络异常，请稍后重试。");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ← 返回工具箱
        </Link>

        <header className="mt-4 mb-8">
          <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-600">
            工作邮件自动发送 · Work Email Auto-Send
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            根据上一封邮件，一键生成下一封工作计划
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            上传上一封「周报工作计划」邮件（PDF / 文本），AI 会顺着上周进度生成下一封工作计划邮件；先预览、可修改，确认后从 adxztech Gmail 发给你指定的收件人。
          </p>
        </header>

        {!gmailConfigured && (
          <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⚠️ 尚未配置发件邮箱：可以正常生成与预览，但暂时无法发送。请在{" "}
            <code className="rounded bg-amber-100 px-1">web/.env.local</code> 里填入{" "}
            <code className="rounded bg-amber-100 px-1">GMAIL_USER</code> 与{" "}
            <code className="rounded bg-amber-100 px-1">GMAIL_APP_PASSWORD</code>（Gmail 应用专用密码）后重启服务。
          </div>
        )}

        {/* ① 上一封邮件 */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">① 上一封工作邮件</h2>
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
              {(["file", "text"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPriorMode(m)}
                  className={`rounded-md px-3 py-1 font-medium transition ${
                    priorMode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                  }`}
                >
                  {m === "file" ? "上传文件" : "粘贴文本"}
                </button>
              ))}
            </div>
          </div>

          {priorMode === "file" ? (
            <label className="mt-3 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500 transition hover:border-amber-300 hover:bg-amber-50/40">
              <input
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => handlePriorFile(e.target.files?.[0] ?? null)}
              />
              {priorFile ? (
                <span className="font-medium text-slate-700">📄 {priorFile.name}</span>
              ) : (
                <span>点击选择 PDF / DOCX 文件（上一封周报邮件）</span>
              )}
            </label>
          ) : (
            <textarea
              value={priorText}
              onChange={(e) => handlePriorText(e.target.value)}
              placeholder="把上一封工作计划邮件的内容粘贴到这里……"
              rows={8}
              className="mt-3 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
            />
          )}
        </div>

        {/* ② 收件人 */}
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">② 指定收件人（assign 用户）</h2>
          <p className="mt-1 text-xs text-slate-400">
            收件人来自「雇员信息」数据库；也可以临时手动填写。
          </p>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
          >
            {recipients.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.name} · {r.email}
              </option>
            ))}
            <option value="custom">✎ 手动填写收件人…</option>
          </select>

          {isCustom && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="收件人姓名（用于问候语）"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
              />
              <input
                value={customEmail}
                onChange={(e) => setCustomEmail(e.target.value)}
                placeholder="收件人邮箱"
                type="email"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
              />
            </div>
          )}
        </div>

        {/* ③ 目标周 */}
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">③ 目标周（这封计划针对哪一周）</h2>
          <input
            value={targetWeek}
            onChange={(e) => {
              setTargetWeek(e.target.value);
              weekTouchedRef.current = true;
              setWeekNote(null);
            }}
            placeholder="例如 July 6–10, 2026"
            className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
          />
          {weekNote ? (
            <p className="mt-1 text-xs text-emerald-600">✓ {weekNote}（上一封的下一周）；可自行修改。</p>
          ) : (
            <p className="mt-1 text-xs text-slate-400">
              上传上一封邮件后会自动识别为它的下一周；未识别到则按今天所在周。可自行修改。
            </p>
          )}
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>
        )}

        <button
          onClick={handleGenerate}
          disabled={loading}
          className="mt-5 w-full rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? LOADING_HINTS[hintIndex] : "生成下一封邮件"}
        </button>

        {/* 草稿：预览 + 编辑 + 发送 */}
        {hasDraft && (
          <div ref={draftRef} className="mt-10 space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                收件信息
              </p>
              <div className="mt-2 space-y-1 text-sm text-slate-600">
                <p>
                  <span className="text-slate-400">收件人：</span>
                  {recipientName || "（未填姓名）"}{" "}
                  <span className="text-slate-500">&lt;{toEmail || "（未填邮箱）"}&gt;</span>
                </p>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-slate-400">抄送 CC：</span>
                  <input
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    placeholder="可选，多个邮箱用逗号分隔"
                    className="w-full rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
                  />
                </div>
              </div>
            </div>

            {/* 主题 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                邮件主题
              </label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
              />
            </div>

            {/* 正文编辑 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                正文（可直接修改；支持 ## 小标题、- 列表、1. 编号、**加粗**）
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-3 py-2 font-mono text-[13px] leading-relaxed text-slate-800 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
              />
            </div>

            {/* 预览 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                邮件预览
              </p>
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                <p className="mb-3 border-b border-slate-200 pb-2 text-sm font-semibold text-slate-900">
                  {subject || "（无主题）"}
                </p>
                <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
              </div>
            </div>

            {sendError && (
              <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{sendError}</p>
            )}

            {sent ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-700 shadow-sm">
                ✅ 已发送！
                <div className="mt-1 text-xs text-emerald-600">
                  <p>发件：{sent.from}</p>
                  <p>收件：{sent.to}</p>
                  {sent.cc.length > 0 && <p>抄送：{sent.cc.join(", ")}</p>}
                </div>
              </div>
            ) : confirming ? (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 shadow-sm">
                <p className="text-sm font-semibold text-amber-800">确认发送这封邮件？</p>
                <p className="mt-1 text-xs text-amber-700">
                  将发送给 <span className="font-medium">{toEmail}</span>
                  {ccList.length > 0 && <>，抄送 {ccList.join(", ")}</>}。此操作会真实发出邮件。
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={handleConfirmSend}
                    disabled={sending || !gmailConfigured}
                    className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sending ? "发送中…" : "确认发送"}
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={sending}
                    className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    取消
                  </button>
                </div>
                {!gmailConfigured && (
                  <p className="mt-2 text-xs text-amber-700">
                    发件邮箱未配置，无法发送（见页面顶部提示）。
                  </p>
                )}
              </div>
            ) : (
              <button
                onClick={handleClickSend}
                className="w-full rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600"
              >
                预览无误，发送 →
              </button>
            )}
          </div>
        )}

        <footer className="mt-16 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}
