"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ALLOWED_FILE_EXTENSIONS,
  EXPENSE_CATEGORY_PRESETS,
  INCOME_CATEGORY_PRESETS,
  isAllowedFileName,
  MAX_FILE_BYTES,
  PAYMENT_METHOD_PRESETS,
  validateExpense,
  type ExpenseInput,
  type ExpenseType,
} from "@/lib/expense/validate";

type Business = { id: number; displayName: string; createdAt: string };
type ExpenseFileItem = {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};
type Expense = {
  id: number;
  businessId: number;
  businessName: string;
  type: ExpenseType;
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
type CategoryTotal = { category: string; total: number; count: number };
type Summary = {
  income: number;
  expense: number;
  net: number;
  count: number;
  byMonth: Array<{ month: string; income: number; expense: number }>;
  byCategory: { expense: CategoryTotal[]; income: CategoryTotal[] };
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

function emptyForm(defaultBusinessId: number | null): ExpenseInput {
  return {
    businessId: defaultBusinessId ? String(defaultBusinessId) : "",
    type: "expense",
    spentOn: todayLocal(),
    amount: "",
    category: "",
    vendor: "",
    paymentMethod: "",
    note: "",
  };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewable(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function typeLabel(t: ExpenseType): string {
  return t === "income" ? "收入" : "支出";
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
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<number | null>(null); // null = 全部

  const [form, setForm] = useState<ExpenseInput>(() => emptyForm(null));
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false); // 正在读 PDF 自动填表
  const [toast, setToast] = useState<string | null>(null);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | ExpenseType>("");

  const [preview, setPreview] = useState<ExpenseFileItem | null>(null);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  const uidRef = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "Business 记账本 · 收支";
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // 首次加载 + 切换 business 时重新拉取(明细/汇总按当前 business 过滤)
  useEffect(() => {
    loadData(selectedBusinessId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBusinessId]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function loadData(businessId: number | null) {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = businessId ? `?businessId=${businessId}` : "";
      const res = await fetch(`/api/business-expense/list${qs}`);
      const json = await res.json();
      if (json.success) {
        setBusinesses(json.businesses as Business[]);
        setExpenses(json.expenses as Expense[]);
        setSummary(json.summary as Summary);
      } else {
        setLoadError(json.error ?? "读取记账本失败,请稍后重试。");
      }
    } catch {
      setLoadError("读取记账本失败,请检查网络或稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  /** 只刷新 business 清单(不动明细),用于管理弹窗内增删改后同步。 */
  async function reloadBusinesses(): Promise<Business[]> {
    try {
      const res = await fetch("/api/business-expense/business");
      const json = await res.json();
      if (json.success) {
        setBusinesses(json.businesses as Business[]);
        return json.businesses as Business[];
      }
    } catch {
      /* ignore */
    }
    return businesses;
  }

  // 表单默认归属:切到某个具体 business 时,新记录默认记到它名下
  useEffect(() => {
    setForm((f) => ({ ...f, businessId: selectedBusinessId ? String(selectedBusinessId) : f.businessId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBusinessId]);

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
      // 新增的 PDF 自动尝试解析并填表(非财务单据静默跳过)
      accepted.filter(isPdfFile).forEach((f) => void autofillFromPdf(f, { silent: true }));
    }
    if (rejected.length) setErrors([`以下凭证未添加:${rejected.join(";")}`]);
  }
  function removePending(uid: number) {
    setPending((p) => p.filter((f) => f.uid !== uid));
  }

  /** 把一份财务单据 PDF 交给服务端解析,识别成功则填入表单(覆盖能识别的字段;不动 business)。 */
  async function autofillFromPdf(file: File, opts: { silent: boolean }) {
    setFilling(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/business-expense/parse-pdf", { method: "POST", body: fd });
      const json = (await res.json()) as {
        success: boolean;
        recognized?: boolean;
        data?: { type: string; spentOn: string; amount: string; category: string; vendor: string; paymentMethod: string; note: string };
        error?: string;
      };
      if (!json.success) {
        if (!opts.silent) showToast(json.error ?? "解析失败,请稍后重试。");
        return;
      }
      if (!json.recognized || !json.data) {
        if (!opts.silent) showToast("未能从该 PDF 识别出收支信息。");
        return;
      }
      const d = json.data;
      setForm((prev) => ({
        ...prev,
        type: d.type === "income" || d.type === "expense" ? d.type : prev.type,
        spentOn: d.spentOn || prev.spentOn,
        amount: d.amount || prev.amount,
        category: d.category || prev.category,
        vendor: d.vendor || prev.vendor,
        paymentMethod: d.paymentMethod || prev.paymentMethod,
        note: d.note || prev.note,
      }));
      showToast("已从 PDF 自动填充");
    } catch {
      if (!opts.silent) showToast("解析失败,请稍后重试。");
    } finally {
      setFilling(false);
    }
  }

  function onReset() {
    setForm(emptyForm(selectedBusinessId));
    setPending([]);
    setErrors([]);
  }

  async function createBusinessFlow(): Promise<number | null> {
    const name = window.prompt("新建 business 名称(如 Sakura Blossom)");
    if (name == null) return null;
    if (!name.trim()) { showToast("business 名称不能为空。"); return null; }
    try {
      const res = await fetch("/api/business-expense/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = (await res.json()) as { success: boolean; id?: number; created?: boolean; error?: string };
      if (!json.success || !json.id) {
        showToast(json.error ?? "新建失败,请稍后重试。");
        return null;
      }
      await reloadBusinesses();
      showToast(json.created ? "已新建 business" : "该 business 已存在,已选中");
      return json.id;
    } catch {
      showToast("新建失败,请稍后重试。");
      return null;
    }
  }

  async function onSave() {
    const errs = validateExpense(form);
    setErrors(errs);
    if (errs.length) return;

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("businessId", form.businessId.trim());
      fd.append("type", form.type);
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
      showToast(`已记一笔${form.type === "income" ? "收入" : "支出"}${json.fileCount ? `,含 ${json.fileCount} 张凭证` : ""}`);
      onReset();
      await loadData(selectedBusinessId);
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
      a.download = `Business_Ledger_${todayLocal()}.xlsx`;
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
    if (!window.confirm(`确认删除这笔${typeLabel(exp.type)}吗?\n${exp.spentOn} · ${usd(exp.amount)} · ${exp.category}\n${exp.files.length ? `将同时删除 ${exp.files.length} 张凭证,` : ""}此操作不可撤销。`)) {
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
      await loadData(selectedBusinessId);
    } catch {
      showToast("删除失败,请稍后重试。");
    } finally {
      setDeletingId(null);
    }
  }

  const currentMonth = todayLocal().slice(0, 7);
  const currentYear = todayLocal().slice(0, 4);
  const monthNet = summary?.byMonth.find((m) => m.month === currentMonth);
  const thisMonthNet = monthNet ? monthNet.income - monthNet.expense : 0;
  const thisYearNet = useMemo(
    () =>
      (summary?.byMonth ?? [])
        .filter((m) => m.month.startsWith(`${currentYear}-`))
        .reduce((s, m) => s + (m.income - m.expense), 0),
    [summary, currentYear],
  );

  const categoryOptions = useMemo(() => {
    if (!summary) return [];
    const set = new Set<string>();
    summary.byCategory.expense.forEach((c) => set.add(c.category));
    summary.byCategory.income.forEach((c) => set.add(c.category));
    return Array.from(set).sort();
  }, [summary]);

  // 切换 business / 删除后,数据变了:若月份/类别筛选值已不在新选项里,自动清掉,
  // 否则受控 <select> 会视觉回落到「全部」但旧筛选仍生效,导致列表莫名空白。
  useEffect(() => {
    if (!summary) return;
    if (monthFilter && !summary.byMonth.some((m) => m.month === monthFilter)) setMonthFilter("");
    if (categoryFilter && !categoryOptions.includes(categoryFilter)) setCategoryFilter("");
  }, [summary, categoryOptions, monthFilter, categoryFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (monthFilter && !e.spentOn.startsWith(monthFilter)) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (!q) return true;
      const hay = [e.businessName, e.category, e.vendor, e.paymentMethod, e.note, e.spentOn, usd(e.amount)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [expenses, query, monthFilter, categoryFilter, typeFilter]);

  const filteredTotals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const e of filtered) {
      if (e.type === "income") income += e.amount;
      else expense += e.amount;
    }
    return { income, expense, net: income - expense };
  }, [filtered]);
  const hasFilter = Boolean(query.trim() || monthFilter || categoryFilter || typeFilter);
  const showBusinessCol = selectedBusinessId === null;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="mb-6">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← 工具箱</Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Business 记账本 <span className="text-slate-400">收支</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            按 business 分账,记录每一笔收入与支出、归档发票/凭证,自动汇总收支与净额,可导出 Excel。金额单位:USD。
          </p>
        </header>

        {/* business 大分类切换栏 */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Pill active={selectedBusinessId === null} onClick={() => setSelectedBusinessId(null)}>全部</Pill>
          {businesses.map((b) => (
            <Pill key={b.id} active={selectedBusinessId === b.id} onClick={() => setSelectedBusinessId(b.id)}>
              {b.displayName}
            </Pill>
          ))}
          <button
            type="button"
            onClick={async () => { const id = await createBusinessFlow(); if (id) setSelectedBusinessId(id); }}
            className="rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-sky-400 hover:text-sky-700"
          >
            ＋ 新建 business
          </button>
          {businesses.length > 0 && (
            <button
              type="button"
              onClick={() => setManagerOpen(true)}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-slate-400"
            >
              ⚙ 管理
            </button>
          )}
        </div>

        {/* 汇总卡片 */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="收入合计" value={usd(summary?.income ?? 0)} tone="income" />
          <SummaryCard label="支出合计" value={usd(summary?.expense ?? 0)} tone="expense" />
          <SummaryCard label="净额(收-支)" value={usd(summary?.net ?? 0)} tone={(summary?.net ?? 0) >= 0 ? "net-pos" : "net-neg"} />
          <SummaryCard label="记账笔数" value={String(summary?.count ?? 0)} tone="plain" />
        </section>
        <p className="mt-2 text-xs text-slate-400">
          本月净额 {usd(thisMonthNet)} · 本年净额 {usd(thisYearNet)}
          {selectedBusinessId !== null && businesses.find((b) => b.id === selectedBusinessId) ? ` · 当前:${businesses.find((b) => b.id === selectedBusinessId)!.displayName}` : " · 当前:全部 business"}
        </p>

        {/* 记一笔 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">记一笔 New Entry</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Business">
              <div className="flex gap-2">
                <select value={form.businessId} onChange={(e) => setField("businessId", e.target.value)} className={inputCls}>
                  <option value="">选择 business…</option>
                  {businesses.map((b) => <option key={b.id} value={String(b.id)}>{b.displayName}</option>)}
                </select>
                <button
                  type="button"
                  onClick={async () => { const id = await createBusinessFlow(); if (id) setField("businessId", String(id)); }}
                  className="shrink-0 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 transition hover:border-sky-400 hover:text-sky-700"
                  title="新建 business"
                >
                  ＋
                </button>
              </div>
            </Field>
            <Field label="类型 Type">
              <div className="flex rounded-xl border border-slate-200 p-1">
                <TypeToggle active={form.type === "expense"} tone="expense" onClick={() => setField("type", "expense")}>支出</TypeToggle>
                <TypeToggle active={form.type === "income"} tone="income" onClick={() => setField("type", "income")}>收入</TypeToggle>
              </div>
            </Field>
            <Field label="日期 Date">
              <input type="date" value={form.spentOn} onChange={(e) => setField("spentOn", e.target.value)} className={inputCls} />
            </Field>
            <Field label="金额 Amount (USD)">
              <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => setField("amount", e.target.value)} placeholder="0.00" className={inputCls} autoComplete="off" />
            </Field>
            <Field label="类别 Category">
              <input type="text" list={form.type === "income" ? "income-categories" : "expense-categories"} value={form.category} onChange={(e) => setField("category", e.target.value)} placeholder={form.type === "income" ? "如 服务收入" : "如 办公用品"} className={inputCls} autoComplete="off" />
            </Field>
            <Field label={form.type === "income" ? "付款方 Payer(选填)" : "收款方 Vendor(选填)"}>
              <input type="text" value={form.vendor} onChange={(e) => setField("vendor", e.target.value)} placeholder={form.type === "income" ? "如 某客户" : "如 Amazon"} className={inputCls} autoComplete="off" />
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
            <p className="mb-1 text-xs font-medium text-slate-600">
              发票 / 凭证 Receipts(选填)
              <span className="ml-2 font-normal text-slate-400">{filling ? "· 正在识别 PDF…" : "· 上传 PDF(如 Stripe 单据)会自动识别并填表"}</span>
            </p>
            <ReceiptUploader pending={pending} onAdd={addReceipts} onRemove={removePending} onAutofill={(f) => autofillFromPdf(f, { silent: false })} filling={filling} />
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" onClick={onSave} disabled={saving} className="rounded-xl bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50">
              {saving ? "保存中…" : "记账"}
            </button>
            <button type="button" onClick={onReset} disabled={saving} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 disabled:opacity-50">
              Reset
            </button>
          </div>

          {errors.length > 0 && (
            <ul className="mt-4 space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {errors.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          )}
        </section>

        {/* 分布 */}
        {summary && (summary.byMonth.length > 0 || summary.byCategory.expense.length > 0 || summary.byCategory.income.length > 0) && (
          <section className="mt-6 grid gap-4 sm:grid-cols-2">
            <MonthCard byMonth={summary.byMonth} />
            <CategoryCard byCategory={summary.byCategory} />
          </section>
        )}

        {/* 明细列表 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">明细 <span className="text-slate-400">Ledger</span></h2>
            <button type="button" onClick={onExport} disabled={exporting || expenses.length === 0} className="rounded-xl border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:border-emerald-400 disabled:opacity-50">
              {exporting ? "导出中…" : "⬇ 导出 Excel(全部)"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 类别 / 对方 / 备注" className="w-48 rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300" />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "" | ExpenseType)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400">
              <option value="">全部收支</option>
              <option value="expense">仅支出</option>
              <option value="income">仅收入</option>
            </select>
            <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400">
              <option value="">全部月份</option>
              {(summary?.byMonth ?? []).map((m) => <option key={m.month} value={m.month}>{m.month}</option>)}
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400">
              <option value="">全部类别</option>
              {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {hasFilter && (
              <button type="button" onClick={() => { setQuery(""); setMonthFilter(""); setCategoryFilter(""); setTypeFilter(""); }} className="text-xs text-slate-400 hover:text-slate-600">清除筛选</button>
            )}
          </div>

          <p className="mt-2 text-xs text-slate-400">
            {hasFilter
              ? `筛选出 ${filtered.length} 笔 · 收入 ${usd(filteredTotals.income)} / 支出 ${usd(filteredTotals.expense)} / 净额 ${usd(filteredTotals.net)}`
              : `共 ${expenses.length} 笔`}
          </p>

          {loading ? (
            <p className="mt-6 text-sm text-slate-400">加载中…</p>
          ) : loadError ? (
            <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              <span>{loadError}</span>
              <button type="button" onClick={() => loadData(selectedBusinessId)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 transition hover:border-red-400">重试</button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-6 text-sm text-slate-400">
              {expenses.length === 0
                ? businesses.length === 0
                  ? "还没有 business,先在上方「＋ 新建 business」建一个,再记账。"
                  : "还没有记账,试试在上面记一笔。"
                : "没有匹配的记录。"}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    {[showBusinessCol ? "Business" : null, "日期", "类型", "金额", "类别", "对方", "付款方式", "凭证", "备注", ""].filter((h) => h !== null).map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100 align-top">
                      {showBusinessCol && <td className="whitespace-nowrap px-2 py-2 text-slate-600">{e.businessName}</td>}
                      <td className="whitespace-nowrap px-2 py-2 text-slate-700">{e.spentOn}</td>
                      <td className="px-2 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${e.type === "income" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{typeLabel(e.type)}</span>
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 font-semibold ${e.type === "income" ? "text-emerald-700" : "text-slate-900"}`}>
                        {e.type === "income" ? "+" : "−"}{usd(e.amount)}
                      </td>
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
                                  <button type="button" onClick={() => setPreview(f)} className="max-w-[130px] truncate font-medium text-sky-700 hover:underline" title={f.originalName}>{f.originalName}</button>
                                ) : (
                                  <a href={`/api/business-expense/file/${f.id}`} className="max-w-[130px] truncate font-medium text-sky-700 hover:underline" title={f.originalName}>{f.originalName}</a>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-500">
                        {e.note ? <span className="block max-w-[180px] whitespace-pre-wrap break-words">{e.note}</span> : "—"}
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

      {/* 类别候选 */}
      <datalist id="expense-categories">{EXPENSE_CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="income-categories">{INCOME_CATEGORY_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="expense-payments">{PAYMENT_METHOD_PRESETS.map((c) => <option key={c} value={c} />)}</datalist>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
      )}

      <FilePreviewModal file={preview} onClose={() => setPreview(null)} />
      <EditExpenseModal
        target={editTarget}
        businesses={businesses}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); showToast("已保存修改"); loadData(selectedBusinessId); }}
        onChanged={() => loadData(selectedBusinessId)}
        onToast={showToast}
        onCreateBusiness={createBusinessFlow}
      />
      <BusinessManagerModal
        open={managerOpen}
        businesses={businesses}
        onClose={() => setManagerOpen(false)}
        onToast={showToast}
        onCreate={createBusinessFlow}
        onChanged={async () => {
          const list = await reloadBusinesses();
          // 若当前选中的 business 被删掉,回到「全部」并刷新明细
          if (selectedBusinessId !== null && !list.some((b) => b.id === selectedBusinessId)) {
            setSelectedBusinessId(null);
          } else {
            loadData(selectedBusinessId);
          }
        }}
      />
    </main>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${active ? "bg-sky-600 text-white shadow-sm" : "border border-slate-200 bg-white text-slate-600 hover:border-sky-300"}`}
    >
      {children}
    </button>
  );
}

function TypeToggle({ active, tone, onClick, children }: { active: boolean; tone: ExpenseType; onClick: () => void; children: React.ReactNode }) {
  const activeCls = tone === "income" ? "bg-emerald-600 text-white" : "bg-rose-600 text-white";
  return (
    <button type="button" onClick={onClick} className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${active ? activeCls : "text-slate-500 hover:text-slate-700"}`}>
      {children}
    </button>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: "income" | "expense" | "net-pos" | "net-neg" | "plain" }) {
  const style = {
    income: { box: "border-emerald-200 bg-emerald-50", text: "text-emerald-700" },
    expense: { box: "border-rose-200 bg-rose-50", text: "text-rose-700" },
    "net-pos": { box: "border-sky-200 bg-sky-50", text: "text-sky-700" },
    "net-neg": { box: "border-amber-200 bg-amber-50", text: "text-amber-700" },
    plain: { box: "border-slate-200 bg-white", text: "text-slate-900" },
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${style.box}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${style.text}`}>{value}</p>
    </div>
  );
}

/** 按月收支:每月两条(收入绿 / 支出红),按各月最大值等比缩放。 */
function MonthCard({ byMonth }: { byMonth: Array<{ month: string; income: number; expense: number }> }) {
  const rows = byMonth.slice(0, 12);
  const max = Math.max(1, ...rows.map((m) => Math.max(m.income, m.expense)));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">按月 收支 By Month</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">暂无数据</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((m) => (
            <li key={m.month}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-700">{m.month}</span>
                <span className="text-slate-500">
                  <span className="text-emerald-700">+{usd(m.income)}</span> · <span className="text-rose-700">−{usd(m.expense)}</span> · <span className={`font-medium ${m.income - m.expense >= 0 ? "text-sky-700" : "text-amber-700"}`}>{usd(m.income - m.expense)}</span>
                </span>
              </div>
              <div className="mt-1 space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${Math.round((m.income / max) * 100)}%` }} /></div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-rose-500" style={{ width: `${Math.round((m.expense / max) * 100)}%` }} /></div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 按类别:支出/收入 子切换,占该类型合计的百分比条。 */
function CategoryCard({ byCategory }: { byCategory: { expense: CategoryTotal[]; income: CategoryTotal[] } }) {
  const [tab, setTab] = useState<ExpenseType>("expense");
  const items = (tab === "income" ? byCategory.income : byCategory.expense).slice(0, 8);
  const total = (tab === "income" ? byCategory.income : byCategory.expense).reduce((s, c) => s + c.total, 0);
  const bar = tab === "income" ? "bg-emerald-500" : "bg-rose-500";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">按类别 By Category</p>
        <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs">
          <button type="button" onClick={() => setTab("expense")} className={`rounded-md px-2 py-0.5 font-medium transition ${tab === "expense" ? "bg-rose-600 text-white" : "text-slate-500"}`}>支出</button>
          <button type="button" onClick={() => setTab("income")} className={`rounded-md px-2 py-0.5 font-medium transition ${tab === "income" ? "bg-emerald-600 text-white" : "text-slate-500"}`}>收入</button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">暂无{tab === "income" ? "收入" : "支出"}数据</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it) => {
            const pct = total > 0 ? Math.round((it.total / total) * 100) : 0;
            return (
              <li key={it.category}>
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-slate-700">{it.category} <span className="text-slate-400">· {it.count}</span></span>
                  <span className="ml-2 shrink-0 font-medium text-slate-900">{usd(it.total)} <span className="text-slate-400">{pct}%</span></span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className={`h-full ${bar}`} style={{ width: `${pct}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 凭证上传:拖拽 / 选择,列出待上传文件可移除。onAutofill 存在时,PDF 行显示「用此填表」。 */
function ReceiptUploader({
  pending,
  onAdd,
  onRemove,
  onAutofill,
  filling,
}: {
  pending: PendingReceipt[];
  onAdd: (files: File[]) => void;
  onRemove: (uid: number) => void;
  onAutofill?: (file: File) => void;
  filling?: boolean;
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
      <input ref={inputRef} type="file" multiple accept={ALLOWED_FILE_EXTENSIONS.map((x) => `.${x}`).join(",")} onChange={(e) => onPick(e.target.files)} className="hidden" />
      <div
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onAdd(Array.from(e.dataTransfer.files)); }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${border}`}
      >
        <button type="button" onClick={() => inputRef.current?.click()} className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-sky-400 hover:text-sky-700">
          + 添加凭证
        </button>
        <span className="text-[11px] text-slate-400">{dragging ? "松开即可添加" : "或把发票/收据拖到此处 · 支持 PDF / 图片 / Word,单个 ≤ 20MB"}</span>
      </div>
      {pending.length > 0 && (
        <ul className="mt-3 space-y-1">
          {pending.map((f) => (
            <li key={f.uid} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate text-slate-700">{f.file.name} <span className="text-slate-400">({fmtSize(f.file.size)})</span></span>
              <span className="flex shrink-0 items-center gap-2">
                {onAutofill && isPdfFile(f.file) && (
                  <button type="button" onClick={() => onAutofill(f.file)} disabled={filling} title="读取此 PDF 自动填表" className="rounded-lg border border-sky-200 px-2 py-0.5 text-sky-700 transition hover:border-sky-400 disabled:opacity-50">📄 填表</button>
                )}
                <button type="button" onClick={() => onRemove(f.uid)} className="rounded-lg border border-slate-200 px-2 py-0.5 text-slate-500 transition hover:border-red-300 hover:text-red-600">移除</button>
              </span>
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

/** 编辑记录弹窗:改 business/类型/字段、追加凭证、删除已有凭证。保存走 PATCH。 */
function EditExpenseModal({
  target,
  businesses,
  onClose,
  onSaved,
  onChanged,
  onToast,
  onCreateBusiness,
}: {
  target: Expense | null;
  businesses: Business[];
  onClose: () => void;
  onSaved: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onCreateBusiness: () => Promise<number | null>;
}) {
  const [form, setForm] = useState<ExpenseInput>(() => emptyForm(null));
  const [existing, setExisting] = useState<ExpenseFileItem[]>([]);
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);
  const uidRef = useRef(0);

  useEffect(() => {
    if (!target) return;
    setForm({
      businessId: String(target.businessId),
      type: target.type,
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
      if (!json.success) { onToast(json.error ?? "删除失败,请稍后重试。"); return; }
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
      fd.append("businessId", form.businessId.trim());
      fd.append("type", form.type);
      fd.append("spentOn", form.spentOn.trim());
      fd.append("amount", form.amount.trim());
      fd.append("category", form.category.trim());
      fd.append("vendor", form.vendor.trim());
      fd.append("paymentMethod", form.paymentMethod.trim());
      fd.append("note", form.note.trim());
      pending.forEach((f) => fd.append("files", f.file));
      const res = await fetch(`/api/business-expense/${target!.id}`, { method: "PATCH", body: fd });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) { setErrors([json.error ?? "保存失败,请稍后重试。"]); return; }
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
          <h3 className="text-sm font-semibold text-slate-800">编辑记录 Edit Entry</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-slate-300">✕ 关闭</button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business">
              <div className="flex gap-2">
                <select value={form.businessId} onChange={(e) => setField("businessId", e.target.value)} className={inputCls}>
                  <option value="">选择 business…</option>
                  {businesses.map((b) => <option key={b.id} value={String(b.id)}>{b.displayName}</option>)}
                </select>
                <button type="button" onClick={async () => { const id = await onCreateBusiness(); if (id) setField("businessId", String(id)); }} className="shrink-0 rounded-xl border border-slate-200 px-3 text-sm text-slate-600 transition hover:border-sky-400 hover:text-sky-700" title="新建 business">＋</button>
              </div>
            </Field>
            <Field label="类型 Type">
              <div className="flex rounded-xl border border-slate-200 p-1">
                <TypeToggle active={form.type === "expense"} tone="expense" onClick={() => setField("type", "expense")}>支出</TypeToggle>
                <TypeToggle active={form.type === "income"} tone="income" onClick={() => setField("type", "income")}>收入</TypeToggle>
              </div>
            </Field>
            <Field label="日期 Date">
              <input type="date" value={form.spentOn} onChange={(e) => setField("spentOn", e.target.value)} className={inputCls} />
            </Field>
            <Field label="金额 Amount (USD)">
              <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => setField("amount", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="类别 Category">
              <input type="text" list={form.type === "income" ? "income-categories" : "expense-categories"} value={form.category} onChange={(e) => setField("category", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label={form.type === "income" ? "付款方 Payer(选填)" : "收款方 Vendor(选填)"}>
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
            <ReceiptUploader pending={pending} onAdd={addReceipts} onRemove={(uid) => setPending((p) => p.filter((f) => f.uid !== uid))} />
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

/** business 管理弹窗:新建 / 改名 / 删除(仅空 business 可删)。 */
function BusinessManagerModal({
  open,
  businesses,
  onClose,
  onToast,
  onCreate,
  onChanged,
}: {
  open: boolean;
  businesses: Business[];
  onClose: () => void;
  onToast: (msg: string) => void;
  onCreate: () => Promise<number | null>;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;

  async function rename(b: Business) {
    const name = window.prompt("重命名 business", b.displayName);
    if (name == null || name.trim() === b.displayName) return;
    if (!name.trim()) { onToast("名称不能为空。"); return; }
    setBusyId(b.id);
    try {
      const res = await fetch(`/api/business-expense/business/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) { onToast(json.error ?? "改名失败。"); return; }
      onToast("已改名");
      onChanged();
    } catch {
      onToast("改名失败,请稍后重试。");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(b: Business) {
    if (!window.confirm(`删除 business「${b.displayName}」?\n(仅当其名下没有任何记录时可删除)`)) return;
    setBusyId(b.id);
    try {
      const res = await fetch(`/api/business-expense/business/${b.id}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) { onToast(json.error ?? "删除失败。"); return; }
      onToast("已删除 business");
      onChanged();
    } catch {
      onToast("删除失败,请稍后重试。");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} className="my-8 w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-800">管理 business</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-slate-300">✕ 关闭</button>
        </div>
        <div className="px-5 py-4">
          <button type="button" onClick={async () => { const id = await onCreate(); if (id) onChanged(); }} className="mb-3 w-full rounded-xl border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-sky-400 hover:text-sky-700">
            ＋ 新建 business
          </button>
          {businesses.length === 0 ? (
            <p className="text-sm text-slate-400">还没有 business。</p>
          ) : (
            <ul className="space-y-2">
              {businesses.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2">
                  <span className="min-w-0 truncate text-sm text-slate-800">{b.displayName}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    <button type="button" onClick={() => rename(b)} disabled={busyId === b.id} className="rounded-lg border border-slate-200 px-2 py-1 font-medium text-slate-600 transition hover:border-sky-400 hover:text-sky-700 disabled:opacity-50">改名</button>
                    <button type="button" onClick={() => remove(b)} disabled={busyId === b.id} className="rounded-lg border border-slate-200 px-2 py-1 font-medium text-slate-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50">删除</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-slate-400">改名会同步更新历史记录的显示;删除仅在该 business 下没有记录时可用。</p>
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
