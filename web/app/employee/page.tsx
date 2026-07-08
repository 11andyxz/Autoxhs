"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ALLOWED_FILE_EXTENSIONS,
  isAllowedFileName,
  MAX_FILE_BYTES,
  sanitizeCategoryName,
  validateEmployee,
  type EmployeeInput,
} from "@/lib/employee/validate";
import { exportFileName } from "@/lib/serviceFee/filename";
import { renderEmailHtml } from "@/lib/workEmail/render";

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
  notes: string;
  createdAt: string;
  updatedAt: string;
  files: EmployeeFileItem[];
};
type FeeRecord = {
  id: number;
  inputStartDate: string;
  inputEndDate: string;
  actualEndDate: string;
  payrollMonths: string[];
  payrollFee: number;
  serviceFee: number;
  total: number;
  createdAt: string;
  result: unknown;
};
type WorkEmailItem = {
  id: number;
  subject: string;
  toEmail: string;
  recipientName: string;
  cc: string[];
  fromEmail: string;
  body: string;
  sentAt: string;
};
/** 统一人员 = 雇员 ∪ 收费客户(按姓名归并)。employee 为 null 表示仅收费客户。 */
type Person = {
  displayName: string;
  firstName: string;
  lastName: string;
  employee: EmployeeWithFiles | null;
  feeClientName: string | null;
  feeHistory: FeeRecord[];
  workEmails: WorkEmailItem[];
};
type EditTarget =
  | { mode: "edit"; employee: EmployeeWithFiles }
  | { mode: "create"; firstName: string; lastName: string };
/** 「添加工作记录」弹窗的上下文：补录到哪个雇员名下，并预填收件人。 */
type AddWorkTarget = { employeeId: number; employeeName: string; toEmail: string };
type PendingFile = { uid: number; file: File; category: string; groupId: number };

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const EMPTY: EmployeeInput = {
  legalFirstName: "",
  legalLastName: "",
  email: "",
  address: "",
  phone: "",
  notes: "",
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

// folderName = 该文件所属「顶层文件夹」名(整个文件夹一次命名,含子目录的文件都归这一个分类);
// 无 folderName 表示手动单独选的文件(各自独立成组)。
type DroppedFile = { file: File; folderName?: string };

/** 从 webkitRelativePath 取顶层文件夹名("Top/sub/file" → "Top");无文件夹返回 undefined。 */
function topFolderOf(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  const parts = relativePath.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[0] : undefined;
}

/** 逐文件校验(空 / >20MB / 非 PDF·图片·Word);默认分类 = 顶层文件夹名(无则空)。 */
function screenFiles(items: DroppedFile[]): { accepted: { file: File; category: string }[]; rejected: string[] } {
  const accepted: { file: File; category: string }[] = [];
  const rejected: string[] = [];
  for (const { file, folderName } of items) {
    if (file.size === 0) { rejected.push(`「${file.name}」是空文件`); continue; }
    if (file.size > MAX_FILE_BYTES) { rejected.push(`「${file.name}」超过 20MB`); continue; }
    if (!isAllowedFileName(file.name)) { rejected.push(`「${file.name}」类型不支持`); continue; }
    accepted.push({ file, category: folderName ? sanitizeCategoryName(folderName) : "" });
  }
  return { accepted, rejected };
}

/** 递归读取目录下所有文件,全部标记为同一顶层 folderName(子目录文件也归到顶层文件夹名)。 */
async function walkDir(entry: FileSystemDirectoryEntry, folderName: string, out: DroppedFile[]): Promise<void> {
  const reader = entry.createReader();
  for (;;) {
    // readEntries 分批返回,需循环读到空为止
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) {
      if (child.isFile) {
        const file = await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, folderName });
      } else if (child.isDirectory) {
        await walkDir(child as FileSystemDirectoryEntry, folderName, out);
      }
    }
  }
}

/** 从拖放数据提取文件:每个顶层文件夹整体归一个 folderName,顶层散文件无 folderName。无 entry 能力时回退为仅文件。 */
async function filesFromDataTransfer(dt: DataTransfer): Promise<DroppedFile[]> {
  const items = dt.items;
  // 同步快照:dt.files / entry 在事件回调返回(await)后可能失效,必须先取
  const plainFiles: DroppedFile[] = Array.from(dt.files).map((file) => ({
    file,
    folderName: topFolderOf(file.webkitRelativePath),
  }));
  const topEntries: FileSystemEntry[] = [];
  if (items && items.length && typeof items[0].webkitGetAsEntry === "function") {
    for (let i = 0; i < items.length; i += 1) {
      const e = items[i].webkitGetAsEntry();
      if (e) topEntries.push(e);
    }
  }
  if (topEntries.length) {
    const out: DroppedFile[] = [];
    for (const e of topEntries) {
      if (e.isFile) {
        const file = await new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, folderName: undefined });
      } else if (e.isDirectory) {
        await walkDir(e as FileSystemDirectoryEntry, e.name, out);
      }
    }
    if (out.length) return out;
  }
  return plainFiles;
}

/**
 * 给新加入的文件分配 groupId(在 setState 之外计算,避免 StrictMode 下重复自增):
 * 有分类的文件按分类归并到同组(同一文件夹/同名分类共用一组);未填分类的各自独立成组。
 * 直接自增传入的 uidRef/gidRef。
 */
function computeAdditions(
  pending: PendingFile[],
  accepted: { file: File; category: string }[],
  uidRef: { current: number },
  gidRef: { current: number },
): PendingFile[] {
  const groupByCat = new Map<string, number>();
  for (const f of pending) if (f.category) groupByCat.set(f.category, f.groupId);
  const additions: PendingFile[] = [];
  for (const a of accepted) {
    let groupId: number;
    if (a.category) {
      const existing = groupByCat.get(a.category);
      if (existing != null) groupId = existing;
      else { gidRef.current += 1; groupId = gidRef.current; groupByCat.set(a.category, groupId); }
    } else {
      gidRef.current += 1; groupId = gidRef.current; // 未分类文件各自独立成组
    }
    uidRef.current += 1;
    additions.push({ uid: uidRef.current, file: a.file, category: a.category, groupId });
  }
  return additions;
}

/** 待上传文件列表:按 groupId 分组(同一文件夹/同分类共用一个分类名输入框,其下列出多个文件)。 */
function PendingFiles({
  pending,
  onSetGroupCategory,
  onRemove,
  onAutofill,
  filling,
}: {
  pending: PendingFile[];
  onSetGroupCategory: (groupId: number, value: string) => void;
  onRemove: (uid: number) => void;
  onAutofill?: (file: File) => void;
  filling?: boolean;
}) {
  if (!pending.length) return null;
  const groups: { groupId: number; category: string; files: PendingFile[] }[] = [];
  const idx = new Map<number, number>();
  for (const f of pending) {
    if (!idx.has(f.groupId)) {
      idx.set(f.groupId, groups.length);
      groups.push({ groupId: f.groupId, category: f.category, files: [] });
    }
    groups[idx.get(f.groupId)!].files.push(f);
  }
  return (
    <ul className="mt-4 space-y-3">
      {groups.map((g) => (
        <li key={g.groupId} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-slate-600">
              分类 Category(如 i983){g.files.length > 1 ? ` · 含 ${g.files.length} 个文件` : ""}
            </span>
            <input
              type="text"
              value={g.category}
              onChange={(e) => onSetGroupCategory(g.groupId, e.target.value)}
              placeholder="如 i983"
              className={inputCls}
              autoComplete="off"
            />
          </label>
          <ul className="mt-2 space-y-1">
            {g.files.map((f) => (
              <li key={f.uid} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-slate-700">
                  {f.file.name} <span className="text-slate-400">({fmtSize(f.file.size)})</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {onAutofill && isPdf(f.file) && (
                    <button
                      type="button"
                      onClick={() => onAutofill(f.file)}
                      disabled={filling}
                      title="把此 I-983 中的雇员信息填入上方表单"
                      className="rounded-lg border border-violet-200 px-2 py-0.5 text-violet-700 transition hover:border-violet-400 disabled:opacity-50"
                    >
                      📄 填表
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(f.uid)}
                    className="rounded-lg border border-slate-200 px-2 py-0.5 text-slate-500 transition hover:border-red-300 hover:text-red-600"
                  >
                    移除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default function EmployeePage() {
  const [form, setForm] = useState<EmployeeInput>(EMPTY);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [filling, setFilling] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<EmployeeFileItem | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [addWorkTarget, setAddWorkTarget] = useState<AddWorkTarget | null>(null);

  const uidRef = useRef(0);
  const gidRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "雇员信息 · Employee Information";
    // 非标准属性,只能运行时设置,使该 input 变为「选择文件夹」
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
    loadPeople();
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  async function loadPeople() {
    try {
      const res = await fetch("/api/employee/people");
      const json = await res.json();
      if (json.success) setPeople(json.people as Person[]);
    } catch {
      /* ignore */
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
  async function onExportFee(rec: FeeRecord, clientName: string) {
    try {
      await downloadExcel({ result: rec.result, clientName }, exportFileName(clientName, rec.inputStartDate, rec.inputEndDate));
    } catch {
      showToast("导出失败,请稍后重试。");
    }
  }

  function setField<K extends keyof EmployeeInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addFiles(items: DroppedFile[]) {
    const { accepted, rejected } = screenFiles(items);
    if (accepted.length) {
      const additions = computeAdditions(pending, accepted, uidRef, gidRef);
      setPending((p) => [...p, ...additions]);
      // 新增的 PDF 自动尝试按 I-983 解析回填表单(非 I-983 静默跳过)
      accepted.filter((a) => isPdf(a.file)).forEach((a) => void autofillFromI983(a.file, { silent: true }));
    }
    if (rejected.length) setErrors([`以下文件未添加:${rejected.join(";")}`]);
  }
  function setGroupCategory(groupId: number, value: string) {
    setPending((p) => p.map((f) => (f.groupId === groupId ? { ...f, category: value } : f)));
  }
  function onPickFiles(list: FileList | null) {
    if (!list || !list.length) return;
    addFiles(Array.from(list).map((f) => ({ file: f, folderName: topFolderOf(f.webkitRelativePath) })));
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
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
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(await filesFromDataTransfer(e.dataTransfer)); // 支持拖入文件夹(递归)
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
      fd.append("notes", (form.notes ?? "").trim());
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
      await loadPeople();
    } catch {
      setErrors(["保存失败,请稍后重试。"]);
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => {
      const emp = p.employee;
      const hay = [
        p.displayName,
        emp?.email,
        emp?.phone,
        emp?.address,
        emp?.notes,
        p.feeClientName,
        ...(emp?.files.map((f) => f.category) ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [people, query]);

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
            <div className="sm:col-span-2">
              <Field label="备注 Notes(选填)">
                <textarea value={form.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} rows={2} placeholder="补充信息…" className={`${inputCls} resize-y`} />
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
            <input ref={folderInputRef} type="file" multiple onChange={(e) => onPickFiles(e.target.files)} className="hidden" />
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-700"
              >
                + 选择文件(可多选)
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-700"
              >
                + 选择文件夹
              </button>
            </div>
            <span className="text-[11px] text-slate-400">
              {dragging ? "松开即可添加(支持文件夹)" : "或把文件 / 文件夹拖拽到此处 · 整个文件夹归为一个分类(用文件夹名) · 支持 PDF / 图片 / Word,单个 ≤ 20MB"}
            </span>
          </div>

          <PendingFiles
            pending={pending}
            onSetGroupCategory={setGroupCategory}
            onRemove={removePending}
            onAutofill={(file) => autofillFromI983(file, { silent: false })}
            filling={filling}
          />
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

        {/* 人员(雇员 + 收费客户合并) */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">人员 <span className="text-slate-400">People</span></h2>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索姓名 / 邮箱 / 分类"
              className="w-56 rounded-xl border border-slate-200 px-3 py-1.5 text-sm outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-300"
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">共 {people.length} 人(雇员 + 收费客户)</p>

          {filtered.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">暂无匹配的人员。</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {filtered.map((p) => {
                const emp = p.employee;
                return (
                  <li key={emp ? `emp-${emp.id}` : `cli-${p.displayName}`} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">{p.displayName}</h3>
                      <div className="flex items-center gap-3">
                        {emp ? (
                          <button
                            type="button"
                            onClick={() => setEditTarget({ mode: "edit", employee: emp })}
                            className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:border-violet-400"
                          >
                            编辑
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditTarget({ mode: "create", firstName: p.firstName, lastName: p.lastName })}
                            className="rounded-lg border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 transition hover:border-violet-400"
                          >
                            录入雇员资料
                          </button>
                        )}
                        {emp && <span className="text-[11px] text-slate-400">创建于 {emp.createdAt}</span>}
                      </div>
                    </div>

                    {emp ? (
                      <>
                        <p className="mt-1 text-xs text-slate-500">
                          {[emp.email, emp.phone, emp.address].filter(Boolean).join(" · ")}
                        </p>
                        {emp.notes && (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">备注:{emp.notes}</p>
                        )}
                        <EmployeeFiles files={emp.files} onPreview={setPreview} />
                      </>
                    ) : (
                      <p className="mt-1 text-xs text-amber-600">仅收费客户,未录入雇员资料</p>
                    )}

                    {p.feeHistory.length > 0 && (
                      <FeeHistory records={p.feeHistory} clientName={p.feeClientName ?? p.displayName} onExport={onExportFee} />
                    )}

                    {emp && (
                      <WorkEmailHistory
                        records={p.workEmails}
                        onAdd={() =>
                          setAddWorkTarget({
                            employeeId: emp.id,
                            employeeName: p.displayName,
                            toEmail: emp.email ?? "",
                          })
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div>
      )}

      <FilePreviewModal file={preview} onClose={() => setPreview(null)} />
      <EditEmployeeModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          showToast("已保存雇员信息");
          loadPeople();
        }}
      />
      <AddWorkEmailModal
        target={addWorkTarget}
        onClose={() => setAddWorkTarget(null)}
        onSaved={() => {
          setAddWorkTarget(null);
          showToast("已添加工作记录");
          loadPeople();
        }}
      />
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

/** 该人员对应收费客户的收费历史表(只读 + 每条 Excel 导出)。 */
function FeeHistory({
  records,
  clientName,
  onExport,
}: {
  records: FeeRecord[];
  clientName: string;
  onExport: (rec: FeeRecord, clientName: string) => void;
}) {
  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">收费记录 Service Fees</p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-[640px] text-[11px]">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              {["Input Start", "Input End", "Actual End", "Payroll Months", "Payroll Fee", "Service Fee", "Total", "Created At", ""].map((h, i) => (
                <th key={i} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="whitespace-nowrap px-2 py-1">{r.inputStartDate}</td>
                <td className="whitespace-nowrap px-2 py-1">{r.inputEndDate}</td>
                <td className="whitespace-nowrap px-2 py-1">{r.actualEndDate}</td>
                <td className="whitespace-nowrap px-2 py-1 text-slate-500">{r.payrollMonths.join(", ") || "—"}</td>
                <td className="px-2 py-1">{usd(r.payrollFee)}</td>
                <td className="px-2 py-1">{usd(r.serviceFee)}</td>
                <td className="px-2 py-1 font-medium">{usd(r.total)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-slate-400">{r.createdAt}</td>
                <td className="whitespace-nowrap px-2 py-1">
                  <button type="button" onClick={() => onExport(r, clientName)} className="font-medium text-emerald-700 hover:underline">Excel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 该雇员的「工作邮件」记录;点标题可展开看正文;可「添加工作记录」补录历史邮件。 */
function WorkEmailHistory({ records, onAdd }: { records: WorkEmailItem[]; onAdd: () => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
          工作邮件记录 Work Emails
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition hover:border-amber-500"
        >
          + 添加工作记录
        </button>
      </div>
      {records.length === 0 ? (
        <p className="mt-1 text-[11px] text-slate-400">
          暂无记录。以前没经工具发送的邮件，可点「添加工作记录」补录进来。
        </p>
      ) : (
      <ul className="mt-1 space-y-1">
        {records.map((m) => {
          const open = openId === m.id;
          return (
            <li key={m.id} className="rounded-md bg-white px-2 py-1.5 text-xs">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : m.id)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-800">{m.subject}</span>
                  <span className="block truncate text-slate-400">
                    发往 {m.toEmail}
                    {m.cc.length > 0 ? ` · 抄送 ${m.cc.join(", ")}` : ""} · {m.sentAt}
                  </span>
                </span>
                <span className="shrink-0 font-medium text-amber-700">
                  {open ? "收起" : "查看正文"}
                </span>
              </button>
              {open && (
                <div
                  className="mt-2 border-t border-slate-100 pt-2"
                  dangerouslySetInnerHTML={{ __html: renderEmailHtml(m.body) }}
                />
              )}
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}

/** 「添加工作记录」弹窗:把以前没入库的工作邮件补录到该雇员名下(只写库,不发信)。 */
function AddWorkEmailModal({
  target,
  onClose,
  onSaved,
}: {
  target: AddWorkTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [sentAt, setSentAt] = useState("");
  const [cc, setCc] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parsedNote, setParsedNote] = useState<string | null>(null);

  // 打开时按目标雇员预填收件人;发送时间默认当下(用户改成真实的过去日期)
  useEffect(() => {
    if (!target) return;
    setSubject("");
    setToEmail(target.toEmail ?? "");
    setRecipientName(target.employeeName ?? "");
    setSentAt(nowLocalInput());
    setCc("");
    setBody("");
    setError(null);
    setParsedNote(null);
    setParsing(false);
  }, [target]);

  // 上传邮件 PDF/Word → 自动解析并填入下面各字段(不发信、不入库)
  async function onPickFile(file: File) {
    setParsing(true);
    setError(null);
    setParsedNote(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/employee/work-email/parse", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as
        | {
            success: boolean;
            data?: {
              subject: string;
              toEmail: string;
              recipientName: string;
              cc: string[];
              sentAt: string;
              body: string;
            };
            error?: string;
          }
        | null;
      if (!json?.success || !json.data) {
        setError(json?.error ?? "解析失败，请手动填写。");
        return;
      }
      const d = json.data;
      // 有值才覆盖:空字段保留原有预填(如收件人邮箱/发送时间)
      if (d.subject) setSubject(d.subject);
      if (d.body) setBody(d.body);
      if (d.toEmail) setToEmail(d.toEmail);
      if (d.recipientName) setRecipientName(d.recipientName);
      if (d.sentAt) setSentAt(d.sentAt);
      if (d.cc.length) setCc(d.cc.join(", "));
      setParsedNote("已从文件自动填写，请核对后保存。");
    } catch {
      setError("解析失败，请稍后重试或手动填写。");
    } finally {
      setParsing(false);
    }
  }

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [target, onClose]);

  if (!target) return null;

  async function onSubmit() {
    if (!target) return;
    if (!subject.trim()) return setError("请填写邮件标题。");
    if (!toEmail.trim()) return setError("请填写收件人邮箱。");
    if (!sentAt.trim()) return setError("请选择发送时间。");
    if (!body.trim()) return setError("请填写邮件正文。");
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/employee/work-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: target.employeeId,
          subject: subject.trim(),
          toEmail: toEmail.trim(),
          recipientName: recipientName.trim(),
          sentAt,
          cc: cc
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
          body,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; error?: string }
        | null;
      if (!json?.success) {
        setError(json?.error ?? "添加失败，请稍后重试。");
        return;
      }
      onSaved();
    } catch {
      setError("网络连接失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-800">
            添加工作记录 · {target.employeeName}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-slate-300"
          >
            ✕ 关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[11px] text-slate-400">
            补录以前没经工具发送、因而没入库的工作邮件。只记录到数据库，<b>不会真的发送邮件</b>。
          </p>

          {/* 上传邮件 PDF/Word → 自动读取并填好下面各项 */}
          <div className="mb-3 rounded-lg border border-dashed border-violet-300 bg-violet-50/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-600">
                有这封邮件的 PDF / Word？上传自动读取标题、收件人、时间和正文
              </span>
              <label
                className={`shrink-0 cursor-pointer rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-700 ${
                  parsing ? "cursor-not-allowed opacity-60" : ""
                }`}
              >
                {parsing ? "解析中…" : "上传并自动读取"}
                <input
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  disabled={parsing}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) onPickFile(f);
                  }}
                />
              </label>
            </div>
            {parsedNote && <p className="mt-1.5 text-[11px] text-emerald-600">{parsedNote}</p>}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">邮件标题 *</span>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="如：Technical Product Analyst Weekly Work Plan | June 29–July 3"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">收件人邮箱 *</span>
                <input
                  type="email"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">发送时间 *</span>
                <input
                  type="datetime-local"
                  value={sentAt}
                  onChange={(e) => setSentAt(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">收件人姓名</span>
                <input
                  type="text"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">抄送（逗号或换行分隔）</span>
                <input
                  type="text"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="可留空"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">邮件正文 *</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                placeholder="把当时那封邮件的正文粘贴进来（支持 ## 小标题、- 列表、**加粗**）"
                className="mt-1 w-full resize-y rounded-lg border border-slate-200 p-3 text-sm leading-relaxed outline-none transition focus:border-violet-400 focus:ring-1 focus:ring-violet-300"
              />
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存记录"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** datetime-local 输入的默认值 = 当前本地时间 'YYYY-MM-DDTHH:MM'。 */
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** 编辑/录入雇员弹窗:预填字段 + 备注,可追加文件。edit→PATCH(按 id 更新),create→POST(新建)。 */
function EditEmployeeModal({
  target,
  onClose,
  onSaved,
}: {
  target: EditTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EmployeeInput>(EMPTY);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const uidRef = useRef(0);
  const gidRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!target) return;
    if (target.mode === "edit") {
      const e = target.employee;
      setForm({
        legalFirstName: e.legalFirstName,
        legalLastName: e.legalLastName,
        email: e.email,
        address: e.address,
        phone: e.phone,
        notes: e.notes,
      });
    } else {
      setForm({ ...EMPTY, legalFirstName: target.firstName, legalLastName: target.lastName });
    }
    setPending([]);
    setErrors([]);
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
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
  const existing = target.mode === "edit" ? target.employee : null;

  function setField<K extends keyof EmployeeInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function addFiles(items: DroppedFile[]) {
    const { accepted, rejected } = screenFiles(items);
    if (accepted.length) {
      const additions = computeAdditions(pending, accepted, uidRef, gidRef);
      setPending((p) => [...p, ...additions]);
    }
    if (rejected.length) setErrors([`以下文件未添加:${rejected.join(";")}`]);
  }
  function setGroupCategory(groupId: number, value: string) {
    setPending((p) => p.map((f) => (f.groupId === groupId ? { ...f, category: value } : f)));
  }
  function removeFile(uid: number) {
    setPending((p) => p.filter((f) => f.uid !== uid));
  }
  function onPick(list: FileList | null) {
    if (!list || !list.length) return;
    addFiles(Array.from(list).map((f) => ({ file: f, folderName: topFolderOf(f.webkitRelativePath) })));
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(await filesFromDataTransfer(e.dataTransfer));
  }

  async function onSubmit() {
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
      fd.append("notes", (form.notes ?? "").trim());
      fd.append("categories", JSON.stringify(pending.map((f) => f.category.trim())));
      pending.forEach((f) => fd.append("files", f.file));
      const res = existing
        ? await fetch(`/api/employee/${existing.id}`, { method: "PATCH", body: fd })
        : await fetch("/api/employee/save", { method: "POST", body: fd });
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
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-8 w-full max-w-2xl rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{existing ? "编辑雇员 Edit Employee" : "录入雇员资料 Add Employee"}</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:border-slate-300">✕ 关闭</button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal First Name">
              <input type="text" value={form.legalFirstName} onChange={(e) => setField("legalFirstName", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Legal Last Name">
              <input type="text" value={form.legalLastName} onChange={(e) => setField("legalLastName", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <Field label="Phone(选填)">
              <input type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} className={inputCls} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address">
                <input type="text" value={form.address} onChange={(e) => setField("address", e.target.value)} className={inputCls} autoComplete="off" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="备注 Notes(选填)">
                <textarea value={form.notes ?? ""} onChange={(e) => setField("notes", e.target.value)} rows={3} placeholder="补充信息…" className={`${inputCls} resize-y`} />
              </Field>
            </div>
          </div>

          {existing && existing.files.length > 0 && (
            <div className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-medium text-slate-600">已有文件(本弹窗只支持新增,不删除)</p>
              <ul className="mt-1 space-y-0.5">
                {existing.files.map((f) => (
                  <li key={f.id} className="text-[11px] text-slate-500">
                    <span className="font-medium text-violet-700">{f.category}</span> · {f.originalName} ({fmtSize(f.sizeBytes)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ALLOWED_FILE_EXTENSIONS.map((x) => `.${x}`).join(",")}
              onChange={(e) => onPick(e.target.files)}
              className="hidden"
            />
            <input ref={folderInputRef} type="file" multiple onChange={(e) => onPick(e.target.files)} className="hidden" />
            <div
              onDragEnter={onDragOver}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
                dragging ? "border-violet-400 bg-violet-50" : "border-slate-300"
              }`}
            >
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-700"
                >
                  + 追加文件
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-violet-400 hover:text-violet-700"
                >
                  + 选择文件夹
                </button>
              </div>
              <span className="text-[11px] text-slate-400">
                {dragging ? "松开即可添加(支持文件夹)" : "或把文件 / 文件夹拖拽到此处 · 整个文件夹归为一个分类(用文件夹名) · PDF / 图片 / Word,单个 ≤ 20MB"}
              </span>
            </div>
            <PendingFiles pending={pending} onSetGroupCategory={setGroupCategory} onRemove={removeFile} />
          </div>

          {errors.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {errors.map((e) => <li key={e}>• {e}</li>)}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-slate-200 px-5 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 disabled:opacity-50">取消</button>
          <button type="button" onClick={onSubmit} disabled={saving} className="rounded-xl bg-violet-600 px-6 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50">{saving ? "保存中…" : "保存修改"}</button>
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
