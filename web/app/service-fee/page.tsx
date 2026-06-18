"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { calculateServiceFee, round2 } from "@/lib/serviceFee/calc";
import { parseDate } from "@/lib/serviceFee/dateUtils";
import type { CalculationResult, ServiceFeeInputs } from "@/lib/serviceFee/types";
import { validateInputs } from "@/lib/serviceFee/validate";

const DEFAULTS = {
  weeklyWorkHours: "20",
  hourlyWage: "",
  taxWithheld: "100",
  payrollFee: "92",
  serviceCharge: "120",
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const num = (s: string, def: number) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : def;
};

function todayMonthDefaults() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = `${y}-${pad(m + 1)}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const last = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
  return { first, last };
}

export default function ServiceFeePage() {
  // 日期
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // 工时 / 工资 / 费用
  const [weeklyWorkHours, setWeeklyWorkHours] = useState(DEFAULTS.weeklyWorkHours);
  const [hourlyWage, setHourlyWage] = useState(DEFAULTS.hourlyWage);
  const [taxWithheld, setTaxWithheld] = useState(DEFAULTS.taxWithheld);
  const [payrollFee, setPayrollFee] = useState(DEFAULTS.payrollFee);
  const [serviceCharge, setServiceCharge] = useState(DEFAULTS.serviceCharge);

  const [result, setResult] = useState<CalculationResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);

  // 首次挂载:日期默认本月(放 effect 内避免 SSR hydration 不一致)
  useEffect(() => {
    document.title = "收费计算器 · Service Fee Calculator";
    const { first, last } = todayMonthDefaults();
    setStartDate(first);
    setEndDate(last);
  }, []);

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

  // 日期范围实时统计(仅依赖日期,工资缺省补 0 不影响计数)
  const datesOk = !!startDate && !!endDate && parseDate(endDate) >= parseDate(startDate);
  const preview = useMemo(() => {
    if (!datesOk) return null;
    return calculateServiceFee({
      ...currentInputs,
      hourlyWage: Number.isFinite(currentInputs.hourlyWage) ? currentInputs.hourlyWage : 0,
    });
  }, [datesOk, currentInputs]);

  // 修改输入后,结果是否已过期
  const stale = useMemo(
    () => (result ? JSON.stringify(currentInputs) !== JSON.stringify(result.inputs) : false),
    [result, currentInputs],
  );

  function onCalculate() {
    const errs = validateInputs(currentInputs);
    setErrors(errs);
    if (errs.length === 0) setResult(calculateServiceFee(currentInputs));
  }

  function onReset() {
    const { first, last } = todayMonthDefaults();
    setStartDate(first);
    setEndDate(last);
    setWeeklyWorkHours(DEFAULTS.weeklyWorkHours);
    setHourlyWage(DEFAULTS.hourlyWage);
    setTaxWithheld(DEFAULTS.taxWithheld);
    setPayrollFee(DEFAULTS.payrollFee);
    setServiceCharge(DEFAULTS.serviceCharge);
    setResult(null);
    setErrors([]);
  }

  async function onExport() {
    if (!result || stale) return;
    setExporting(true);
    setErrors([]);
    try {
      const res = await fetch("/api/service-fee/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.inputs),
      });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Service_Fee_Calculation_${result.inputs.startDate}_to_${result.inputs.endDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setErrors(["导出失败,请稍后重试。"]);
    } finally {
      setExporting(false);
    }
  }

  const canExport = !!result && !stale && !exporting;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* 头部 */}
        <header className="mb-8">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">
            ← 工具箱
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            收费计算器 <span className="text-slate-400">Service Fee Calculator</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            根据工作时间、时薪、预扣税、Payroll Fee 与 Service Charge,按真实日历计算指定区间总费用,并导出 Excel 明细。
          </p>
        </header>

        {/* 1. 日期范围 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">日期范围</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Start Date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label="End Date">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </Field>
          </div>

          {/* 日期统计 */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="总天数" value={preview ? preview.totalCalendarDays : "—"} />
            <Stat label="工作周" value={preview ? preview.workWeekCount : "—"} />
            <Stat label="Tax 次数(每2周)" value={preview ? preview.taxChargeCount : "—"} />
            <Stat label="涉及月份" value={preview ? preview.monthCount : "—"} />
            <Stat label="Service 收费次数" value={preview ? preview.serviceChargeCount : "—"} />
          </div>
        </section>

        {/* 2. 工时 / 工资 / 费用 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">工时、时薪与各项费用</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Work Hours Per Week" hint={`Daily = ${+(num(weeklyWorkHours, 20) / 5).toFixed(2)} h/day (Weekly ÷ 5)`}>
              <input type="number" min={0} step="0.01" value={weeklyWorkHours} onChange={(e) => setWeeklyWorkHours(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Hourly Wage ($/hour)">
              <input type="number" min={0} step="0.01" placeholder="例如 19" value={hourlyWage} onChange={(e) => setHourlyWage(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Tax Withheld Per Biweekly Payroll ($)" hint="每个唯一双周收一次">
              <input type="number" min={0} step="0.01" value={taxWithheld} onChange={(e) => setTaxWithheld(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Monthly Payroll Fee ($)" hint="每个自然月收一次">
              <input type="number" min={0} step="0.01" value={payrollFee} onChange={(e) => setPayrollFee(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Monthly Service Charge ($)" hint="从 Start 起每月同一天收一次">
              <input type="number" min={0} step="0.01" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} className={inputCls} />
            </Field>
          </div>
        </section>

        {/* 按钮 */}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onCalculate} className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700">
            Calculate
          </button>
          <button type="button" onClick={onReset} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300">
            Reset
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={!canExport}
            title={!result ? "请先点击 Calculate 完成计算" : stale ? "输入已修改,请先重新点击 Calculate" : "导出当前结果为 Excel"}
            className="rounded-xl border border-emerald-600 px-5 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
          >
            {exporting ? "导出中…" : "Export Excel"}
          </button>
        </div>

        {/* 错误 */}
        {errors.length > 0 && (
          <ul className="mt-4 space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
            {errors.map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}

        {/* 过期提示 */}
        {result && stale && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            输入已修改,当前结果可能已过期,请重新点击 Calculate。
          </div>
        )}

        {/* 3. 汇总 */}
        {result && (
          <>
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Calculation Summary</h2>
              <p className="mt-1 text-xs text-slate-400">
                {result.inputs.startDate} → {result.inputs.endDate} · {result.totalCalendarDays} 天 ·{" "}
                {result.totalWorkingDays} 工作日 · {result.totalWorkHours} 工时 · 时薪 {usd(result.inputs.hourlyWage)}
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
                      <td className="px-4 py-3 text-right text-xl font-extrabold text-emerald-700">
                        {usd(result.grandTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {/* 4a. 工时明细(按自然工作周) */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">
                工时明细 <span className="text-slate-400">Work Hours by Week</span>
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                按自然工作周(周一–周日)切割,每周补足整周 {result.weeklyWorkHours} 工时;共 {result.workWeekCount} 周。
                Tax Withheld 每 2 周收一次 $100(第 1、3、5… 周)。
              </p>
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
                        <td className={`px-3 py-2 ${w.taxWithheld > 0 ? "font-medium text-slate-700" : "text-slate-300"}`}>{usd(w.taxWithheld)}</td>
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

            {/* 4b. 费用明细(Payroll,按原始选择区间) */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">
                费用明细 <span className="text-slate-400">Fee Breakdown</span>
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Payroll Fee 每个自然月 $92;Service Charge 从 Start Date 起每月同一天收一次 $120。
                (Tax Withheld 见上方工时周表。)
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[680px] text-xs">
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
                        <td className="px-3 py-2">{usd(row.payrollFee)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{row.serviceChargeDate || "—"}</td>
                        <td className="px-3 py-2">{usd(row.serviceCharge)}</td>
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
                      <td className="px-3 py-2 text-emerald-700">
                        {usd(round2(result.totalPayrollFees + result.totalServiceCharge))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
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
