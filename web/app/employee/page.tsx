"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ALLOWED_FILE_EXTENSIONS,
  isAllowedFileName,
  MAX_FILE_BYTES,
  validateEmployee,
  type EmployeeInput,
} from "@/lib/employee/validate";

type EmployeeFileItem = {
  id: number;
  category: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};
type EmployeeWithFiles = {
  id: number;
  legalFirstName: string;
  legalLastName: string;
  email: string;
  address: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
  files: EmployeeFileItem[];
};
type PendingFile = { uid: number; file: File; category: string };

const EMPTY: EmployeeInput = {
  legalFirstName: "",
  legalLastName: "",
  email: "",
  address: "",
  phone: "",
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** 可在浏览器内嵌预览的类型:PDF 与图片(Word 不支持,只下载)。 */
function isPreviewable(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

export default function EmployeePage() {
  const [form, setForm] = useState<EmployeeInput>(EMPTY);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [filling, setFilling] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [employees, setEmployees] = useState<EmployeeWithFiles[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<EmployeeFileItem | null>(null);

  const uidRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "雇员信息 · Employee Information";
    loadEmployees();
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function loadEmployees() {
    try {
      const res = await fetch("/api/employee/list");
      const json = await res.json();
      if (json.success) setEmployees(json.employees as EmployeeWithFiles[]);
    } catch {
      /* ignore */
    }
  }

  function setField<K extends keyof EmployeeInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onPickFiles(list: FileList | null) {
    if (!list || !list.length) return;
    const added: PendingFile[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      if (file.size === 0) {
        rejected.push(`「${file.name}」是空文件`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`「${file.name}」超过 20MB`);
        continue;
      }
      if (!isAllowedFileName(file.name)) {
        rejected.push(`「${file.name}」类型不支持`);
        continue;
      }
      uidRef.current += 1;
      added.push({ uid: uidRef.current, file, category: "" });
    }
    if (added.length) {
      setPending((p) => [...p, ...added]);
      // 新增的 PDF 自动尝试按 I-983 解析回填表单(非 I-983 静默跳过)
      added.filter((a) => isPdf(a.file)).forEach((a) => void autofillFromI983(a.file, { silent: true }));
    }
    if (rejected.length) setErrors([`以下文件未添加:${rejected.join(";")}`]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /** 把一个 I-983 PDF 交给服务端解析,识别成功则回填表单(覆盖能识别的字段)。 */
  async function autofillFromI983(file: File, opts: { silent: boolean }) {
    setFilling(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/employee/parse-i983", { method: "POST", body: fd });
      const json = (await res.json()) as {
        success: boolean;
        recognized?: boolean;
        data?: { firstName: string; lastName: string; email: string; address: string; phone: string };
        error?: string;
      };
      if (!json.success) {
        if (!opts.silent) showToast(json.error ?? "解析失败,请稍后重试。");
        return;
      }
      if (!json.recognized || !json.data) {
        if (!opts.silent) showToast("未能从该 PDF 识别出 I-983 信息。");
        return;
      }
      const d = json.data;
      setForm((prev) => ({
        legalFirstName: d.firstName || prev.legalFirstName,
        legalLastName: d.lastName || prev.legalLastName,
        email: d.email || prev.email,
        address: d.address || prev.address,
        phone: prev.phone, // I-983 不含雇员本人电话,保持原值
      }));
      showToast("已从 I-983 自动填充表单");
    } catch {
      if (!opts.silent) showToast("解析失败,请稍后重试。");
    } finally {
      setFilling(false);
    }
  }

  function setCategory(uid: number, category: string) {
    setPending((p) => p.map((f) => (f.uid === uid ? { ...f, category } : f)));
  }
  function removePending(uid: number) {
    setPending((p) => p.filter((f) => f.uid !== uid));
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault(); // 允许放置
    if (!dragging) setDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    // 只在真正离开拖放区(而非移到其子元素)时取消高亮
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    onPickFiles(e.dataTransfer.files); // 复用点击选择的同一套校验/列表逻辑
  }

  function onReset() {
    setForm(EMPTY);
    setPending([]);
    setErrors([]);
  }

  async function onSave() {
    const errs = validateEmployee(form);
    pending.forEach((f) => {
      if (!f.category.trim()) errs.push(`请为文件「${f.file.name}」填写分类(例如 i983)。`);
    });
    setErrors(errs);
    if (errs.length) return;

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("legalFirstName", form.legalFirstName.trim());
      fd.append("legalLastName", form.legalLastName.trim());
      fd.append("email", form.email.trim());
      fd.append("address", form.address.trim());
      fd.append("phone", form.phone.trim());
      fd.append("categories", JSON.stringify(pending.map((f) => f.category.trim())));
      pending.forEach((f) => fd.append("files", f.file));

      const res = await fetch("/api/employee/save", { method: "POST", body: fd });
      const json = (await res.json()) as {
        success: boolean;
        created?: boolean;
        fileCount?: number;
        error?: string;
      };
      if (!json.success) {
        setErrors([json.error ?? "保存失败,请稍后重试。"]);
        return;
      }
      showToast(
        `${json.created ? "已保存雇员" : "已更新雇员(同邮箱)"}${json.fileCount ? `,含 ${json.fileCount} 个文件` : ""}`,
      );
      onReset();
      await loadEmployees();
    } catch {
      setErrors(["保存失败,请稍后重试。"]);
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.legalFirstName, e.legalLastName, e.email, e.phone, e.address]
        .join(" ")
        .toLowerCase()
        .includes(q) || e.files.some((f) => f.category.toLowerCase().includes(q)),
    );
  }, [employees, query]);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-10">
        <header className="mb-8">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← 工具箱</Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            雇员信息 <span className="text-slate-400">Employee Information</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            录入雇员基本信息并上传文件,为每个文件填写分类(如 i983),Save 后按分类归档存入数据库。
          </p>
        </header>

        {/* 基本信息 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">基本信息 Basic Info</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Legal First Name">
              <input type="text" value={form.legalFirstName} onChange={(e) => setField("legalFirstName", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Legal Last Name">
              <input type="text" value={form.legalLastName} onChange={(e) => setField("legalLastName", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} placeholder="name@example.com" className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Phone(选填)">
              <input type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} placeholder="(555) 123-4567" className={inputCls} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address">
                <input type="text" value={form.address} onChange={(e) => setField("address", e.target.value)} className={inputCls} autoComplete="off" />
              </Field>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-slate-400">同一 Email 视为同一雇员:再次保存会更新其信息并追加新文件。</p>
        </section>

        {/* 上传文件 */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">上传文件 Upload Files</h2>
          <p className="mt-1 text-[11px] text-slate-400">
            {filling ? "正在识别 I-983…" : "上传 I-983 PDF 会自动识别学生信息并填入上方表单(姓名 / 邮箱 / 地址;电话需手填)。"}
          </p>
          <div
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-5 py-8 text-center transition ${
              dragging ? "border-violet-400 bg-violet-50" : "border-slate-300"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ALLOWED_FILE_EXTENSIONS.map((x) => `.${x}`).join(",")}
              onChange={(e) => onPickFiles(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-700"
            >
              + 选择文件(可多选)
            </button>
            <span className="text-[11px] text-slate-400">
              {dragging ? "松开即可添加文件" : "或把文件拖拽到此处 · 支持 PDF / 图片 / Word,单个 ≤ 20MB"}
            </span>
          </div>

          {pending.length > 0 && (
            <ul className="mt-4 space-y-3">
              {pending.map((f) => (
                <li key={f.uid} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{f.file.name}</p>
                      <p className="text-[11px] text-slate-400">{fmtSize(f.file.size)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isPdf(f.file) && (
                        <button
                          type="button"
                          onClick={() => autofillFromI983(f.file, { silent: false })}
                          disabled={filling}
                          title="把此 I-983 中的雇员信息填入上方表单"
                          className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs text-violet-700 transition hover:border-violet-400 disabled:opacity-50"
                        >
                          📄 用此 I-983 填表
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removePending(f.uid)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-red-300 hover:text-red-600"
                      >
                        移除
                      </button>
                    </div>
                  </div>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[11px] font-medium text-slate-600">分类 Category(该文件归入哪个分类,如 i983)</span>
                    <input
                      type="text"
                      value={f.category}
                      onChange={(e) => setCategory(f.uid, e.target.value)}
                      placeholder="如 i983"
                      className={inputCls}
                      autoComplete="off"
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 按钮 */}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? "保存中…" : "Save to Database"}
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

        {/* 已有雇员 */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">已有雇员 <span className="text-slate-400">Employees</span></h2>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索姓名 / 邮箱 / 分类"
              className="w-56 rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300"
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">共 {employees.length} 位雇员</p>

          {filtered.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">暂无匹配的雇员。</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {filtered.map((emp) => (
                <li key={emp.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      {emp.legalFirstName} {emp.legalLastName}
                    </h3>
                    <span className="text-[11px] text-slate-400">创建于 {emp.createdAt}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {emp.email} · {emp.phone} · {emp.address}
                  </p>
                  <EmployeeFiles files={emp.files} onPreview={setPreview} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
      )}

      <FilePreviewModal file={preview} onClose={() => setPreview(null)} />
    </main>
  );
}

function EmployeeFiles({
  files,
  onPreview,
}: {
  files: EmployeeFileItem[];
  onPreview: (f: EmployeeFileItem) => void;
}) {
  if (!files.length) return <p className="mt-3 text-xs text-slate-400">无文件</p>;
  const byCategory = new Map<string, EmployeeFileItem[]>();
  for (const f of files) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  return (
    <div className="mt-3 space-y-2">
      {Array.from(byCategory.entries()).map(([category, list]) => (
        <div key={category} className="rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">{category}</p>
          <ul className="mt-1 space-y-1">
            {list.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-slate-700">{f.originalName} <span className="text-slate-400">({fmtSize(f.sizeBytes)})</span></span>
                <span className="flex shrink-0 items-center gap-3">
                  {isPreviewable(f.mimeType) && (
                    <button type="button" onClick={() => onPreview(f)} className="font-medium text-violet-700 hover:underline">
                      预览
                    </button>
                  )}
                  <a href={`/api/employee/file/${f.id}`} className="font-medium text-violet-700 hover:underline">
                    下载
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** 页面内文件预览弹窗:PDF 用 iframe、图片用 img;遮罩点击 / ESC / × 关闭,打开时锁定背景滚动。 */
function FilePreviewModal({ file, onClose }: { file: EmployeeFileItem | null; onClose: () => void }) {
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
  const src = `/api/employee/file/${file.id}?inline=1`;
  const isImage = file.mimeType.startsWith("image/");
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-medium text-slate-800">{file.originalName}</p>
          <div className="flex shrink-0 items-center gap-3 text-xs">
            <a href={src} target="_blank" rel="noopener noreferrer" className="font-medium text-violet-700 hover:underline">新标签打开</a>
            <a href={`/api/employee/file/${file.id}`} className="font-medium text-violet-700 hover:underline">下载</a>
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
