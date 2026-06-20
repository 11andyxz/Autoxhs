"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { calculateServiceFee, round2 } from "@/lib/serviceFee/calc";
import { parseDate } from "@/lib/serviceFee/dateUtils";
import { exportFileName } from "@/lib/serviceFee/filename";
import type { CalculationResult, PriorCharges, ServiceFeeInputs } from "@/lib/serviceFee/types";
import { validateInputs } from "@/lib/serviceFee/validate";

const DEFAULTS = {
  weeklyWorkHours: "20",
  hourlyWage: "",
  taxWithheld: "100",
  payrollFee: "92",
  serviceCharge: "120",
};
const EMPTY_PRIOR: PriorCharges = { payrollMonths: [], serviceMonths: [], taxWeeks: [] };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const num = (s: string, def: number) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : def;
};

type HistoryRecord = {
  id: number;
  inputStartDate: string;
  inputEndDate: string;
  actualEndDate: string;
  grossWages: number;
  totalTax: number;
  totalPayrollFees: number;
  totalServiceCharge: number;
  grandTotal: number;
  payrollFeeMonths: string[];
  createdAt: string;
  result: CalculationResult;
};
type ClientInfo = {
  exists: boolean;
  displayName?: string;
  suggestedNextStartDate: string | null;
  history: HistoryRecord[];
};
type Committed = { result: CalculationResult; clientName: string; priorCharges: PriorCharges };

function todayMonthDefaults() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { first: `${y}-${pad(m + 1)}-01`, last: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}` };
}

export default function ServiceFeePage() {
  const [clientName, setClientName] = useState("");
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [weeklyWorkHours, setWeeklyWorkHours] = useState(DEFAULTS.weeklyWorkHours);
  const [hourlyWage, setHourlyWage] = useState(DEFAULTS.hourlyWage);
  const [taxWithheld, setTaxWithheld] = useState(DEFAULTS.taxWithheld);
  const [payrollFee, setPayrollFee] = useState(DEFAULTS.payrollFee);
  const [serviceCharge, setServiceCharge] = useState(DEFAULTS.serviceCharge);

  const [committed, setCommitted] = useState<Committed | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "收费计算器 · Service Fee Calculator";
    const { first, last } = todayMonthDefaults();
    setStartDate(first);
    setEndDate(last);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  const currentInputs: ServiceFeeInputs = useMemo(
    () => ({
      startDate,
      endDate,
      weeklyWorkHours: num(weeklyWorkHours, 20),
      hourlyWage: hourlyWage.trim() === "" ? NaN : num(hourlyWage, NaN),
      taxWithheldPerPayroll: num(taxWithheld, 100),
      monthlyPayrollFee: num(payrollFee, 92),
      monthlyServiceCharge: num(serviceCharge, 120),
    }),
    [startDate, endDate, weeklyWorkHours, hourlyWage, taxWithheld, payrollFee, serviceCharge],
  );

  const datesOk = !!startDate && !!endDate && parseDate(endDate) >= parseDate(startDate);
  const preview = useMemo(() => {
    if (!datesOk) return null;
    return calculateServiceFee({
      ...currentInputs,
      hourlyWage: Number.isFinite(currentInputs.hourlyWage) ? currentInputs.hourlyWage : 0,
    });
  }, [datesOk, currentInputs]);

  // 结果是否已过期(客户名或输入变了就要重算)
  const stale = useMemo(() => {
    if (!committed) return false;
    return (
      JSON.stringify(currentInputs) !== JSON.stringify(committed.result.inputs) ||
      clientName.trim().toLowerCase() !== committed.clientName.trim().toLowerCase()
    );
  }, [committed, currentInputs, clientName]);

  async function lookupClient(name: string, range?: { start: string; end: string }) {
    const res = await fetch("/api/clients/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        inputStartDate: range?.start,
        inputEndDate: range?.end,
      }),
    });
    if (!res.ok) throw new Error("lookup failed");
    return (await res.json()) as {
      success: boolean;
      exists: boolean;
      displayName?: string;
      priorCharges: PriorCharges;
      suggestedNextStartDate: string | null;
      history: HistoryRecord[];
    };
  }

  async function onClientBlur() {
    const name = clientName.trim();
    if (!name) {
      setClientInfo(null);
      return;
    }
    try {
      const data = await lookupClient(name);
      setClientInfo({
        exists: data.exists,
        displayName: data.displayName,
        suggestedNextStartDate: data.suggestedNextStartDate,
        history: data.history ?? [],
      });
    } catch {
      // 查不到也不阻塞,留空
      setClientInfo(null);
    }
  }

  async function onCalculate() {
    const name = clientName.trim();
    const errs = validateInputs(currentInputs);
    if (!name) errs.unshift("请先填写客户姓名。");
    setErrors(errs);
    if (errs.length) return;

    setCalculating(true);
    try {
      let prior = EMPTY_PRIOR;
      try {
        const data = await lookupClient(name, { start: startDate, end: endDate });
        prior = data.priorCharges ?? EMPTY_PRIOR;
        setClientInfo({
          exists: data.exists,
          displayName: data.displayName,
          suggestedNextStartDate: data.suggestedNextStartDate,
          history: data.history ?? [],
        });
      } catch {
        showToast("未能加载客户历史(数据库不可用),本次未去重");
      }
      const result = calculateServiceFee(currentInputs, prior);
      setCommitted({ result, clientName: name, priorCharges: prior });
    } finally {
      setCalculating(false);
    }
  }

  function onReset() {
    const { first, last } = todayMonthDefaults();
    setClientName("");
    setClientInfo(null);
    setStartDate(first);
    setEndDate(last);
    setWeeklyWorkHours(DEFAULTS.weeklyWorkHours);
    setHourlyWage(DEFAULTS.hourlyWage);
    setTaxWithheld(DEFAULTS.taxWithheld);
    setPayrollFee(DEFAULTS.payrollFee);
    setServiceCharge(DEFAULTS.serviceCharge);
    setCommitted(null);
    setErrors([]);
    setOpenDetail(null);
  }

  async function onSave() {
    if (!committed || stale) return;
    setSaving(true);
    setErrors([]);
    try {
      const doSave = async (force: boolean) => {
        const res = await fetch("/api/service-fee/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: committed.clientName, inputs: committed.result.inputs, force }),
        });
        return (await res.json()) as { success: boolean; duplicate?: boolean; updated?: boolean; error?: string };
      };
      let json = await doSave(false);
      if (json.duplicate) {
        if (!window.confirm("该客户在相同日期区间已有记录,是否更新覆盖?")) {
          setSaving(false);
          return;
        }
        json = await doSave(true);
      }
      if (!json.success) {
        setErrors([json.error ?? "保存失败,请稍后重试。"]);
        return;
      }
      showToast(json.updated ? "已更新数据库记录" : "已保存到数据库");
      // 刷新历史
      try {
        const data = await lookupClient(committed.clientName);
        setClientInfo({
          exists: data.exists,
          displayName: data.displayName,
          suggestedNextStartDate: data.suggestedNextStartDate,
          history: data.history ?? [],
        });
      } catch {
        /* ignore */
      }
    } catch {
      setErrors(["保存失败,请稍后重试。"]);
    } finally {
      setSaving(false);
    }
  }

  async function downloadExcel(payload: object, filename: string) {
    const res = await fetch("/api/service-fee/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function onExport() {
    if (!committed || stale) return;
    setExporting(true);
    setErrors([]);
    try {
      await downloadExcel(
        {
          inputs: committed.result.inputs,
          priorCharges: committed.priorCharges,
          clientName: committed.clientName,
        },
        exportFileName(committed.clientName, committed.result.inputStartDateISO, committed.result.inputEndDateISO),
      );
    } catch {
      setErrors(["导出失败,请稍后重试。"]);
    } finally {
      setExporting(false);
    }
  }

  async function onExportHistory(rec: HistoryRecord) {
    const name = committed?.clientName || clientInfo?.displayName || clientName.trim() || "Client";
    try {
      await downloadExcel(
        { result: rec.result, clientName: name },
        exportFileName(name, rec.inputStartDate, rec.inputEndDate),
      );
    } catch {
      showToast("导出失败,请稍后重试。");
    }
  }

  const result = committed?.result ?? null;
  const canAct = !!result && !stale;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="mb-8">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← 工具箱</Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            收费计算器 <span className="text-slate-400">Service Fee Calculator</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            按客户管理收费记录,跨记录去重(Tax 按周、Payroll/Service 按月),并保存到数据库、导出 Excel。
          </p>
        </header>

        {/* 客户 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">客户 Client</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Client Name / 客户姓名">
              <input
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                onBlur={onClientBlur}
                placeholder="例如 John Smith"
                className={inputCls}
              />
            </Field>
            {clientInfo && (
              <div className="flex flex-col justify-center text-xs text-slate-500">
                {clientInfo.exists ? (
                  <span className="text-emerald-700">已有客户「{clientInfo.displayName}」· {clientInfo.history.length} 条历史记录</span>
                ) : (
                  <span>新客户(暂无历史记录)</span>
                )}
                {clientInfo.suggestedNextStartDate && (
                  <div className="mt-1 flex items-center gap-2">
                    <span>建议下次开始日期:<b className="text-slate-700">{clientInfo.suggestedNextStartDate}</b></span>
                    <button
                      type="button"
                      onClick={() => setStartDate(clientInfo.suggestedNextStartDate!)}
                      className="rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-300"
                    >
                      Use Suggested Date
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 日期范围 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">日期范围</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Start Date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Input End Date" hint={preview ? `Actual End Date(顺延后)= ${preview.actualEndDate}` : undefined}>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="总天数" value={preview ? preview.totalCalendarDays : "—"} />
            <Stat label="工作周" value={preview ? preview.workWeekCount : "—"} />
            <Stat label="Tax 次数(每2周)" value={preview ? preview.taxChargeCount : "—"} />
            <Stat label="涉及月份" value={preview ? preview.monthCount : "—"} />
            <Stat label="Service 收费次数" value={preview ? preview.serviceChargeCount : "—"} />
          </div>
        </section>

        {/* 工时 / 费用 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">工时、时薪与各项费用</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Work Hours Per Week" hint={`Daily = ${+(num(weeklyWorkHours, 20) / 5).toFixed(2)} h/day`}>
              <input type="number" min={0} step="0.01" value={weeklyWorkHours} onChange={(e) => setWeeklyWorkHours(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Hourly Wage ($/hour)">
              <input type="number" min={0} step="0.01" placeholder="例如 17" value={hourlyWage} onChange={(e) => setHourlyWage(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Tax Withheld Per Biweekly ($)" hint="每 2 个工作周收一次">
              <input type="number" min={0} step="0.01" value={taxWithheld} onChange={(e) => setTaxWithheld(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Monthly Payroll Fee ($)" hint="每个自然月收一次">
              <input type="number" min={0} step="0.01" value={payrollFee} onChange={(e) => setPayrollFee(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Monthly Service Charge ($)" hint="每月同一天收一次">
              <input type="number" min={0} step="0.01" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} className={inputCls} />
            </Field>
          </div>
        </section>

        {/* 按钮 */}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onCalculate} disabled={calculating} className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50">
            {calculating ? "计算中…" : "Calculate"}
          </button>
          <button type="button" onClick={onReset} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300">
            Reset
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!canAct || saving}
            title={!result ? "请先 Calculate" : stale ? "输入已改,请重新 Calculate" : "保存本次结果到数据库"}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {saving ? "保存中…" : "Save to Database"}
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={!canAct || exporting}
            title={!result ? "请先 Calculate" : stale ? "输入已改,请重新 Calculate" : "导出 Excel"}
            className="rounded-xl border border-emerald-600 px-5 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            {exporting ? "导出中…" : "Export Excel"}
          </button>
        </div>

        {errors.length > 0 && (
          <ul className="mt-4 space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            {errors.map((e) => <li key={e}>• {e}</li>)}
          </ul>
        )}
        {result && stale && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            客户姓名或输入已修改,当前结果已过期,请重新点击 Calculate(否则无法保存/导出)。
          </div>
        )}

        {result && (
          <>
            {/* 汇总 */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Calculation Summary</h2>
              <p className="mt-1 text-xs text-slate-400">
                客户 {committed?.clientName} · Input {result.inputStartDate} → {result.inputEndDate}
                {result.actualEndDateISO !== result.inputEndDateISO && (
                  <> · <span className="text-amber-600">Actual End {result.actualEndDate}(已顺延)</span></>
                )}
                {" "}· {result.totalWorkHours} 工时 · 时薪 {usd(result.inputs.hourlyWage)}
              </p>
              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <tbody>
                    <SummaryRow label="Gross Wages" value={usd(result.grossWages)} />
                    <SummaryRow label="Tax Withheld" value={usd(result.totalTaxWithheld)} />
                    <SummaryRow label="Payroll Fees" value={usd(result.totalPayrollFees)} />
                    <SummaryRow label="Service Charge" value={usd(result.totalServiceCharge)} />
                  </tbody>
                  <tfoot>
                    <tr className="bg-emerald-50">
                      <td className="px-4 py-3 text-base font-bold text-slate-900">Grand Total</td>
                      <td className="px-4 py-3 text-right text-xl font-extrabold text-emerald-700">{usd(result.grandTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* 工时明细 */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">工时明细 <span className="text-slate-400">Work Hours by Week</span></h2>
              <p className="mt-1 text-xs text-slate-400">每周补足整周 {result.weeklyWorkHours} 工时;Tax 每 2 周收一次 $100,「已收」= 该周之前已收过。</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[900px] text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      {["工作周", "覆盖区间", "实际工作日", "计入工作日", "Work Hours", "时薪", "Gross Wages", "Tax Withheld", "调整类型"].map((h) => (
                        <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.workWeeks.map((w) => (
                      <tr key={w.index} className="border-b border-slate-100">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{w.workWeekStart} – {w.workWeekEnd}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{w.coveredStart} – {w.coveredEnd}</td>
                        <td className="px-3 py-2">{w.actualWorkingDays}</td>
                        <td className="px-3 py-2">{w.adjustedWorkingDays}</td>
                        <td className="px-3 py-2">{w.workHours}</td>
                        <td className="px-3 py-2">{usd(w.hourlyWage)}</td>
                        <td className="px-3 py-2 font-medium">{usd(w.grossWages)}</td>
                        <td className={`px-3 py-2 ${w.taxWithheld > 0 ? "font-medium text-slate-700" : "text-slate-300"}`}>
                          {usd(w.taxWithheld)}{w.taxAlreadyBilled && <span className="ml-1 text-[10px] text-amber-600">已收</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-400">{w.adjustmentType}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 font-bold text-slate-900">
                      <td className="px-3 py-2" colSpan={3}>Total</td>
                      <td className="px-3 py-2">{result.totalAdjustedWorkingDays}</td>
                      <td className="px-3 py-2">{result.totalWorkHours}</td>
                      <td className="px-3 py-2">—</td>
                      <td className="px-3 py-2 text-emerald-700">{usd(result.grossWages)}</td>
                      <td className="px-3 py-2">{usd(result.totalTaxWithheld)}</td>
                      <td className="px-3 py-2">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* 费用明细 */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">费用明细 <span className="text-slate-400">Fee Breakdown</span></h2>
              <p className="mt-1 text-xs text-slate-400">Payroll Fee 每月 $92、Service Charge 每月 $120;「已收」= 该月此前已对该客户收过。</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      {["自然月", "覆盖区间", "Payroll Fee", "Service Charge Date", "Service Charge", "小计"].map((h) => (
                        <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.feeRows.map((row, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{row.payrollMonth}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{row.coveredStart} – {row.coveredEnd}</td>
                        <td className="px-3 py-2">{usd(row.payrollFee)}{row.payrollAlreadyBilled && <span className="ml-1 text-[10px] text-amber-600">已收</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{row.serviceChargeDate || "—"}</td>
                        <td className="px-3 py-2">{usd(row.serviceCharge)}{row.serviceAlreadyBilled && <span className="ml-1 text-[10px] text-amber-600">已收</span>}</td>
                        <td className="px-3 py-2 font-medium">{usd(row.subtotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 font-bold text-slate-900">
                      <td className="px-3 py-2" colSpan={2}>Total</td>
                      <td className="px-3 py-2">{usd(result.totalPayrollFees)}</td>
                      <td className="px-3 py-2">—</td>
                      <td className="px-3 py-2">{usd(result.totalServiceCharge)}</td>
                      <td className="px-3 py-2 text-emerald-700">{usd(round2(result.totalPayrollFees + result.totalServiceCharge))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </>
        )}

        {/* 客户历史记录 */}
        {clientInfo && clientInfo.history.length > 0 && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">客户历史记录 <span className="text-slate-400">History</span></h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[860px] text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    {["Input Start", "Input End", "Actual End", "Payroll Months", "Payroll Fee", "Service Fee", "Total", "Created At", ""].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {clientInfo.history.map((rec) => (
                    <Fragment key={rec.id}>
                      <tr className="border-b border-slate-100">
                        <td className="whitespace-nowrap px-3 py-2">{rec.inputStartDate}</td>
                        <td className="whitespace-nowrap px-3 py-2">{rec.inputEndDate}</td>
                        <td className="whitespace-nowrap px-3 py-2">{rec.actualEndDate}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{rec.payrollFeeMonths.join(", ") || "—"}</td>
                        <td className="px-3 py-2">{usd(rec.totalPayrollFees)}</td>
                        <td className="px-3 py-2">{usd(rec.totalServiceCharge)}</td>
                        <td className="px-3 py-2 font-medium">{usd(rec.grandTotal)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-400">{rec.createdAt}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <button type="button" onClick={() => setOpenDetail(openDetail === rec.id ? null : rec.id)} className="text-slate-500 hover:text-slate-800">View</button>
                          <button type="button" onClick={() => onExportHistory(rec)} className="ml-3 text-emerald-700 hover:underline">Excel</button>
                        </td>
                      </tr>
                      {openDetail === rec.id && (
                        <tr className="bg-slate-50">
                          <td colSpan={9} className="px-3 py-2 text-[11px] text-slate-600">
                            Gross {usd(rec.grossWages)} · Tax {usd(rec.totalTax)} · Payroll {usd(rec.totalPayrollFees)} · Service {usd(rec.totalServiceCharge)} · Grand {usd(rec.grandTotal)} · 工时 {rec.result?.totalWorkHours}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
      )}
    </main>
  );
}

const inputCls =
  "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2 text-center">
      <div className="text-lg font-bold text-slate-900">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-slate-100">
      <td className="px-4 py-2.5 text-slate-600">{label}</td>
      <td className="px-4 py-2.5 text-right font-medium text-slate-900">{value}</td>
    </tr>
  );
}
