"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ALLOWED_FILE_EXTENSIONS,
  CATEGORY_PRESETS,
  isAllowedFileName,
  MAX_FILE_BYTES,
  PAYMENT_METHOD_PRESETS,
  validateExpense,
  type ExpenseInput,
} from "@/lib/expense/validate";

type ExpenseFileItem = {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};
type Expense = {
  id: number;
  spentOn: string;
  amount: number;
  category: string;
  vendor: string;
  paymentMethod: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  files: ExpenseFileItem[];
};
type Summary = {
  grandTotal: number;
  count: number;
  byMonth: Array<{ month: string; total: number; count: number }>;
  byCategory: Array<{ category: string; total: number; count: number }>;
};
type PendingReceipt = { uid: number; file: File };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyForm(): ExpenseInput {
  return { spentOn: todayLocal(), amount: "", category: "", vendor: "", paymentMethod: "", note: "" };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewable(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

/** 逐文件校验(空 / >20MB / 非 PDF·图片·Word)。 */
function screenReceipts(files: File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (file.size === 0) { rejected.push(`「${file.name}」是空文件`); continue; }
    if (file.size > MAX_FILE_BYTES) { rejected.push(`「${file.name}」超过 20MB`); continue; }
    if (!isAllowedFileName(file.name)) { rejected.push(`「${file.name}」类型不支持`); continue; }
    accepted.push(file);
  }
  return { accepted, rejected };
}

export default function BusinessExpensePage() {
  const [form, setForm] = useState<ExpenseInput>(emptyForm);
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  const [preview, setPreview] = useState<ExpenseFileItem | null>(null);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const uidRef = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "Business 花费 · 记账本";
    loadData();
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/business-expense/list");
      const json = await res.json();
      if (json.success) {
        setExpenses(json.expenses as Expense[]);
        setSummary(json.summary as Summary);
      } else {
        // 读取失败时明确报错,避免和「空账本」外观混淆(DB 故障 ≠ 没有记录)
        setLoadError(json.error ?? "读取记账本失败,请稍后重试。");
      }
    } catch {
      setLoadError("读取记账本失败,请检查网络或稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function setField<K extends keyof ExpenseInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addReceipts(files: File[]) {
    const { accepted, rejected } = screenReceipts(files);
    if (accepted.length) {
      const additions = accepted.map((file) => {
        uidRef.current += 1;
        return { uid: uidRef.current, file };
      });
      setPending((p) => [...p, ...additions]);
    }
    if (rejected.length) setErrors([`以下凭证未添加:${rejected.join(";")}`]);
  }
  function removePending(uid: number) {
    setPending((p) => p.filter((f) => f.uid !== uid));
  }

  function onReset() {
    setForm(emptyForm());
    setPending([]);
    setErrors([]);
  }

  async function onSave() {
    const errs = validateExpense(form);
    setErrors(errs);
    if (errs.length) return;

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("spentOn", form.spentOn.trim());
      fd.append("amount", form.amount.trim());
      fd.append("category", form.category.trim());
      fd.append("vendor", form.vendor.trim());
      fd.append("paymentMethod", form.paymentMethod.trim());
      fd.append("note", form.note.trim());
      pending.forEach((f) => fd.append("files", f.file));

      const res = await fetch("/api/business-expense/save", { method: "POST", body: fd });
      const json = (await res.json()) as { success: boolean; fileCount?: number; error?: string };
      if (!json.success) {
        setErrors([json.error ?? "保存失败,请稍后重试。"]);
        return;
      }
      showToast(`已记一笔${json.fileCount ? `,含 ${json.fileCount} 张凭证` : ""}`);
      onReset();
      await loadData();
    } catch {
      setErrors(["保存失败,请稍后重试。"]);
    } finally {
      setSaving(false);
    }
  }

  async function onExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/business-expense/export");
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Business_Expenses_${todayLocal()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast("导出失败,请稍后重试。");
    } finally {
      setExporting(false);
    }
  }

  async function onDelete(exp: Expense) {
    if (!window.confirm(`确认删除这笔花费吗?\n${exp.spentOn} · ${usd(exp.amount)} · ${exp.category}\n${exp.files.length ? `将同时删除 ${exp.files.length} 张凭证,` : ""}此操作不可撤销。`)) {
      return;
    }
    setDeletingId(exp.id);
    try {
      const res = await fetch(`/api/business-expense/${exp.id}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        showToast(json.error ?? "删除失败,请稍后重试。");
        return;
      }
      showToast("已删除");
      await loadData();
    } catch {
      showToast("删除失败,请稍后重试。");
    } finally {
      setDeletingId(null);
    }
  }

  const currentMonth = todayLocal().slice(0, 7);
  const currentYear = todayLocal().slice(0, 4);
  const thisMonthTotal = summary?.byMonth.find((m) => m.month === currentMonth)?.total ?? 0;
  const thisYearTotal = useMemo(
    () =>
      (summary?.byMonth ?? [])
        .filter((m) => m.month.startsWith(`${currentYear}-`))
        .reduce((s, m) => s + m.total, 0),
    [summary, currentYear],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses.filter((e) => {
      if (monthFilter && !e.spentOn.startsWith(monthFilter)) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (!q) return true;
      const hay = [e.category, e.vendor, e.paymentMethod, e.note, e.spentOn, usd(e.amount)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [expenses, query, monthFilter, categoryFilter]);

  const filteredTotal = useMemo(() => filtered.reduce((s, e) => s + e.amount, 0), [filtered]);
  const hasFilter = Boolean(query.trim() || monthFilter || categoryFilter);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="mb-8">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← 工具箱</Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Business 花费 <span className="text-slate-400">记账本</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            记录公司每一笔支出并归档发票/凭证,自动按月、按类别汇总,可随时导出 Excel。金额单位:USD。
          </p>
        </header>

        {/* 汇总卡片 */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="总支出" value={usd(summary?.grandTotal ?? 0)} accent />
          <SummaryCard label="本月支出" value={usd(thisMonthTotal)} />
          <SummaryCard label="本年支出" value={usd(thisYearTotal)} />
          <SummaryCard label="记账笔数" value={String(summary?.count ?? 0)} />
        </section>

        {/* 记一笔 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">记一笔 New Expense</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="日期 Date">
              <input type="date" value={form.spentOn} onChange={(e) => setField("spentOn", e.target.value)} className={inputCls} />
            </Field>
            <Field label="金额 Amount (USD)">
              <input
                type="text"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setField("amount", e.target.value)}
                placeholder="0.00"
                className={inputCls}
                autoComplete="off"
              />
            </Field>
            <Field label="类别 Category">
              <input type="text" list="expense-categories" value={form.category} onChange={(e) => setField("category", e.target.value)} placeholder="如 办公用品" className={inputCls} autoComplete="off" />
            </Field>
            <Field label="收款方 Vendor(选填)">
              <input type="text" value={form.vendor} onChange={(e) => setField("vendor", e.target.value)} placeholder="如 Amazon" className={inputCls} autoComplete="off" />
            </Field>
            <Field label="付款方式 Payment(选填)">
              <input type="text" list="expense-payments" value={form.paymentMethod} onChange={(e) => setField("paymentMethod", e.target.value)} placeholder="如 信用卡" className={inputCls} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="备注 Note(选填)">
                <textarea value={form.note} onChange={(e) => setField("note", e.target.value)} rows={2} placeholder="补充说明…" className={`${inputCls} resize-y`} />
              </Field>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-1 text-xs font-medium text-slate-600">发票 / 凭证 Receipts(选填)</p>
            <ReceiptUploader pending={pending} onAdd={addReceipts} onRemove={removePending} accent="sky" />
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="rounded-xl bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "记账"}
            </button>
            <button
              type="button"
              onClick={onReset}
              disabled={saving}
              className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 disabled:opacity-50"
            >
              Reset
            </button>
          </div>

          {errors.length > 0 && (
            <ul className="mt-4 space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {errors.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          )}
        </section>

        {/* 类别 / 月度分布 */}
        {summary && (summary.byCategory.length > 0 || summary.byMonth.length > 0) && (
          <section className="mt-6 grid gap-4 sm:grid-cols-2">
            <BreakdownCard title="按类别 By Category" grandTotal={summary.grandTotal} items={summary.byCategory.map((c) => ({ label: c.category, total: c.total, count: c.count }))} accent="sky" />
            <BreakdownCard title="按月 By Month" grandTotal={summary.grandTotal} items={summary.byMonth.map((m) => ({ label: m.month, total: m.total, count: m.count }))} accent="emerald" />
          </section>
        )}

        {/* 明细列表 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">明细 <span className="text-slate-400">Ledger</span></h2>
            <button
              type="button"
              onClick={onExport}
              disabled={exporting || expenses.length === 0}
              className="rounded-xl border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:border-emerald-400 disabled:opacity-50"
            >
              {exporting ? "导出中…" : "⬇ 导出 Excel"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 类别 / 收款方 / 备注"
              className="w-56 rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300"
            />
            <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400">
              <option value="">全部月份</option>
              {(summary?.byMonth ?? []).map((m) => (
                <option key={m.month} value={m.month}>{m.month}</option>
              ))}
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400">
              <option value="">全部类别</option>
              {(summary?.byCategory ?? []).map((c) => (
                <option key={c.category} value={c.category}>{c.category}</option>
              ))}
            </select>
            {hasFilter && (
              <button type="button" onClick={() => { setQuery(""); setMonthFilter(""); setCategoryFilter(""); }} className="text-xs text-slate-400 hover:text-slate-600">清除筛选</button>
            )}
          </div>

          <p className="mt-2 text-xs text-slate-400">
            {hasFilter
              ? `筛选出 ${filtered.length} 笔,合计 ${usd(filteredTotal)}`
              : `共 ${expenses.length} 笔`}
          </p>

          {loading ? (
            <p className="mt-6 text-sm text-slate-400">加载中…</p>
          ) : loadError ? (
            <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              <span>{loadError}</span>
              <button type="button" onClick={loadData} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 transition hover:border-red-400">重试</button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">{expenses.length === 0 ? "还没有记账,试试在上面记一笔。" : "没有匹配的记录。"}</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    {["日期", "金额", "类别", "收款方", "付款方式", "凭证", "备注", ""].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100 align-top">
                      <td className="whitespace-nowrap px-2 py-2 text-slate-700">{e.spentOn}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-semibold text-slate-900">{usd(e.amount)}</td>
                      <td className="px-2 py-2">
                        <span className="inline-flex rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">{e.category}</span>
                      </td>
                      <td className="px-2 py-2 text-slate-600">{e.vendor || "—"}</td>
                      <td className="px-2 py-2 text-slate-600">{e.paymentMethod || "—"}</td>
                      <td className="px-2 py-2">
                        {e.files.length === 0 ? (
                          <span className="text-xs text-slate-300">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {e.files.map((f) => (
                              <li key={f.id} className="flex items-center gap-2 text-xs">
                                {isPreviewable(f.mimeType) ? (
                                  <button type="button" onClick={() => setPreview(f)} className="max-w-[140px] truncate font-medium text-sky-700 hover:underline" title={f.originalName}>{f.originalName}</button>
                                ) : (
                                  <a href={`/api/business-expense/file/${f.id}`} className="max-w-[140px] truncate font-medium text-sky-700 hover:underline" title={f.originalName}>{f.originalName}</a>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-500">
                        {e.note ? <span className="block max-w-[200px] whitespace-pre-wrap break-words">{e.note}</span> : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditTarget(e)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-sky-400 hover:text-sky-700">编辑</button>
                          <button type="button" onClick={() => onDelete(e)} disabled={deletingId === e.id} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50">{deletingId === e.id ? "删除中…" : "删除"}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* 类别 / 付款方式 候选 */}
      <datalist id="expense-categories">
        {CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id="expense-payments">
        {PAYMENT_METHOD_PRESETS.map((c) => <option key={c} value={c} />)}
      </datalist>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
      )}

      <FilePreviewModal file={preview} onClose={() => setPreview(null)} />
      <EditExpenseModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); showToast("已保存修改"); loadData(); }}
        onChanged={loadData}
        onToast={showToast}
      />
    </main>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${accent ? "border-sky-200 bg-sky-50" : "border-slate-200 bg-white"}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${accent ? "text-sky-700" : "text-slate-900"}`}>{value}</p>
    </div>
  );
}

function BreakdownCard({
  title,
  items,
  grandTotal,
  accent,
}: {
  title: string;
  items: Array<{ label: string; total: number; count: number }>;
  grandTotal: number;
  accent: "sky" | "emerald";
}) {
  const bar = accent === "sky" ? "bg-sky-500" : "bg-emerald-500";
  const head = accent === "sky" ? "text-sky-700" : "text-emerald-700";
  const top = items.slice(0, 8);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className={`text-xs font-semibold uppercase tracking-wide ${head}`}>{title}</p>
      {top.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">暂无数据</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {top.map((it) => {
            const pct = grandTotal > 0 ? Math.round((it.total / grandTotal) * 100) : 0;
            return (
              <li key={it.label}>
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-700">{it.label} <span className="text-slate-400">· {it.count}</span></span>
                  <span className="ml-2 shrink-0 font-medium text-slate-900">{usd(it.total)} <span className="text-slate-400">{pct}%</span></span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
          {items.length > top.length && <li className="text-[11px] text-slate-400">…另有 {items.length - top.length} 项</li>}
        </ul>
      )}
    </div>
  );
}

/** 凭证上传:拖拽 / 选择,列出待上传文件可移除。 */
function ReceiptUploader({
  pending,
  onAdd,
  onRemove,
  accent,
}: {
  pending: PendingReceipt[];
  onAdd: (files: File[]) => void;
  onRemove: (uid: number) => void;
  accent: "sky";
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const border = dragging ? "border-sky-400 bg-sky-50" : "border-slate-300";

  function onPick(list: FileList | null) {
    if (!list || !list.length) return;
    onAdd(Array.from(list));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_FILE_EXTENSIONS.map((x) => `.${x}`).join(",")}
        onChange={(e) => onPick(e.target.files)}
        className="hidden"
      />
      <div
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onAdd(Array.from(e.dataTransfer.files)); }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${border}`}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-sky-400 hover:text-sky-700"
        >
          + 添加凭证
        </button>
        <span className="text-[11px] text-slate-400">
          {dragging ? "松开即可添加" : "或把发票/收据拖到此处 · 支持 PDF / 图片 / Word,单个 ≤ 20MB"}
        </span>
      </div>
      {pending.length > 0 && (
        <ul className="mt-3 space-y-1">
          {pending.map((f) => (
            <li key={f.uid} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate text-slate-700">{f.file.name} <span className="text-slate-400">({fmtSize(f.file.size)})</span></span>
              <button type="button" onClick={() => onRemove(f.uid)} className="shrink-0 rounded-lg border border-slate-200 px-2 py-0.5 text-slate-500 transition hover:border-red-300 hover:text-red-600">移除</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 凭证预览弹窗:PDF 用 iframe、图片用 img;遮罩点击 / ESC / × 关闭。 */
function FilePreviewModal({ file, onClose }: { file: ExpenseFileItem | null; onClose: () => void }) {
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [file, onClose]);

  if (!file) return null;
  const src = `/api/business-expense/file/${file.id}?inline=1`;
  const isImage = file.mimeType.startsWith("image/");
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-medium text-slate-800">{file.originalName}</p>
          <div className="flex shrink-0 items-center gap-3 text-xs">
            <a href={src} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 hover:underline">新标签打开</a>
            <a href={`/api/business-expense/file/${file.id}`} className="font-medium text-sky-700 hover:underline">下载</a>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-slate-500 transition hover:border-slate-300">✕ 关闭</button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-50">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={file.originalName} className="max-h-[80vh] max-w-full object-contain" />
          ) : (
            <iframe src={src} title={file.originalName} className="h-[80vh] w-full" />
          )}
        </div>
      </div>
    </div>
  );
}

/** 编辑花费弹窗:改字段、追加凭证、删除已有凭证。保存走 PATCH。 */
function EditExpenseModal({
  target,
  onClose,
  onSaved,
  onChanged,
  onToast,
}: {
  target: Expense | null;
  onClose: () => void;
  onSaved: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const [form, setForm] = useState<ExpenseInput>(emptyForm);
  const [existing, setExisting] = useState<ExpenseFileItem[]>([]);
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);
  const uidRef = useRef(0);

  useEffect(() => {
    if (!target) return;
    setForm({
      spentOn: target.spentOn,
      amount: String(target.amount),
      category: target.category,
      vendor: target.vendor,
      paymentMethod: target.paymentMethod,
      note: target.note,
    });
    setExisting(target.files);
    setPending([]);
    setErrors([]);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [target, onClose]);

  if (!target) return null;

  function setField<K extends keyof ExpenseInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function addReceipts(files: File[]) {
    const { accepted, rejected } = screenReceipts(files);
    if (accepted.length) {
      const additions = accepted.map((file) => {
        uidRef.current += 1;
        return { uid: uidRef.current, file };
      });
      setPending((p) => [...p, ...additions]);
    }
    if (rejected.length) setErrors([`以下凭证未添加:${rejected.join(";")}`]);
  }

  async function deleteExisting(fileId: number) {
    if (!window.confirm("删除这张凭证吗?此操作不可撤销。")) return;
    setDeletingFileId(fileId);
    try {
      const res = await fetch(`/api/business-expense/file/${fileId}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        onToast(json.error ?? "删除失败,请稍后重试。");
        return;
      }
      setExisting((list) => list.filter((f) => f.id !== fileId));
      onChanged();
    } catch {
      onToast("删除失败,请稍后重试。");
    } finally {
      setDeletingFileId(null);
    }
  }

  async function onSubmit() {
    const errs = validateExpense(form);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("spentOn", form.spentOn.trim());
      fd.append("amount", form.amount.trim());
      fd.append("category", form.category.trim());
      fd.append("vendor", form.vendor.trim());
      fd.append("paymentMethod", form.paymentMethod.trim());
      fd.append("note", form.note.trim());
      pending.forEach((f) => fd.append("files", f.file));
      const res = await fetch(`/api/business-expense/${target!.id}`, { method: "PATCH", body: fd });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) {
        setErrors([json.error ?? "保存失败,请稍后重试。"]);
        return;
      }
      onSaved();
    } catch {
      setErrors(["保存失败,请稍后重试。"]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} className="my-8 w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-800">编辑花费 Edit Expense</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-slate-300">✕ 关闭</button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="日期 Date">
              <input type="date" value={form.spentOn} onChange={(e) => setField("spentOn", e.target.value)} className={inputCls} />
            </Field>
            <Field label="金额 Amount (USD)">
              <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => setField("amount", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="类别 Category">
              <input type="text" list="expense-categories" value={form.category} onChange={(e) => setField("category", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="收款方 Vendor(选填)">
              <input type="text" value={form.vendor} onChange={(e) => setField("vendor", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="付款方式 Payment(选填)">
              <input type="text" list="expense-payments" value={form.paymentMethod} onChange={(e) => setField("paymentMethod", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="备注 Note(选填)">
                <textarea value={form.note} onChange={(e) => setField("note", e.target.value)} rows={3} className={`${inputCls} resize-y`} />
              </Field>
            </div>
          </div>

          {existing.length > 0 && (
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-medium text-slate-600">已有凭证</p>
              <ul className="mt-1 space-y-1">
                {existing.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-slate-700">{f.originalName} <span className="text-slate-400">({fmtSize(f.sizeBytes)})</span></span>
                    <span className="flex shrink-0 items-center gap-3">
                      <a href={`/api/business-expense/file/${f.id}`} className="font-medium text-sky-700 hover:underline">下载</a>
                      <button type="button" onClick={() => deleteExisting(f.id)} disabled={deletingFileId === f.id} className="rounded-lg border border-slate-200 px-2 py-0.5 text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50">{deletingFileId === f.id ? "删除中…" : "删除"}</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-medium text-slate-600">追加凭证(选填)</p>
            <ReceiptUploader pending={pending} onAdd={addReceipts} onRemove={(uid) => setPending((p) => p.filter((f) => f.uid !== uid))} accent="sky" />
          </div>

          {errors.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {errors.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-slate-200 px-5 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 disabled:opacity-50">取消</button>
          <button type="button" onClick={onSubmit} disabled={saving} className="rounded-xl bg-sky-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50">{saving ? "保存中…" : "保存修改"}</button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
