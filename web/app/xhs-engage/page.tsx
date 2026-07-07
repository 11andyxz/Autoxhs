"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_DELAY_SEC,
  type EngageNote,
  MAX_COMMENT_CHARS,
  MAX_DELAY_SEC,
  MAX_NOTES,
  MAX_PAGES,
  MAX_STYLE_HINT,
  MIN_DELAY_SEC,
  type NoteSource,
} from "@/lib/xiaohongshu/engage";
import { parseNoteRef } from "@/lib/xiaohongshu/url";

type PreviewStatus = "loading" | "ready" | "error";
type Preview = { title: string; comment: string; status: PreviewStatus; error?: string };

// "unknown" = 已发出请求但拿不到确切结果(评论可能已发)，绝不自动重试，只允许用户手动确认后重试。
type ExecStatus = "pending" | "running" | "ok" | "error" | "unknown";
type ExecResult = {
  status: ExecStatus;
  commentPosted?: boolean;
  commentLiked?: boolean;
  noteLiked?: boolean;
  note?: string;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function XhsEngagePage() {
  // —— 来源 ——
  const [sourceMode, setSourceMode] = useState<NoteSource>("search");
  const [keyword, setKeyword] = useState("");
  const [pages, setPages] = useState(1);
  const [linksText, setLinksText] = useState("");
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  // —— 候选与勾选 ——
  const [candidates, setCandidates] = useState<EngageNote[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // —— 互动选项 ——
  const [likeComment, setLikeComment] = useState(true);
  const [likeNote, setLikeNote] = useState(true);
  const [styleHint, setStyleHint] = useState("");
  const [delaySec, setDelaySec] = useState(DEFAULT_DELAY_SEC);

  // —— 预览（生成评论，无副作用）——
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({ done: 0, total: 0 });

  // —— 执行（真实写操作）——
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execProgress, setExecProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<Record<string, ExecResult>>({});

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  const candidateById = useMemo(() => {
    const m = new Map<string, EngageNote>();
    for (const n of candidates) m.set(n.id, n);
    return m;
  }, [candidates]);

  // 勾选顺序 = 候选列表顺序，保证生成/执行确定性
  const selectedNotes = useMemo(
    () => candidates.filter((n) => selectedIds.has(n.id)),
    [candidates, selectedIds],
  );

  const hasPreviews = Object.keys(previews).length > 0;
  const busy = loadingNotes || generating || executing;
  // 候选中已评论过 / 未评论 的数量（用于提示 + 自动勾选跳过已评论）
  const commentedCount = useMemo(() => candidates.filter((n) => n.commented).length, [candidates]);
  const freshCount = candidates.length - commentedCount;

  // 切换来源 / 重新取候选时，清空下游状态，避免残留
  function resetDownstream() {
    setSelectedIds(new Set());
    setPreviews({});
    setResults({});
    setAwaitingConfirm(false);
    setGenProgress({ done: 0, total: 0 });
    setExecProgress({ done: 0, total: 0 });
  }

  function toggleSelect(id: string) {
    const note = candidateById.get(id);
    const isSelected = selectedIds.has(id);
    if (!isSelected) {
      if (selectedIds.size >= MAX_NOTES) {
        showToast(`单批最多 ${MAX_NOTES} 篇，避免触发风控`);
        return;
      }
      if (note?.commented) showToast("这篇之前评论过，注意别重复");
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // 勾选变化后，之前的预览/结果不再对应，清掉重来
    setPreviews({});
    setResults({});
    setAwaitingConfirm(false);
  }

  // 取候选：搜索 / 信息流
  async function fetchNotes() {
    if (sourceMode === "search" && !keyword.trim()) {
      setNotesError("请输入搜索关键词。");
      return;
    }
    setLoadingNotes(true);
    setNotesError(null);
    resetDownstream();
    try {
      const res = await fetch("/api/xiaohongshu/engage/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: sourceMode, keyword: keyword.trim(), pages }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; notes?: EngageNote[]; error?: string }
        | null;
      if (!json?.success || !json.notes) {
        setNotesError(json?.error ?? "获取笔记失败，请确认本地 rednote 服务在运行。");
        setCandidates([]);
        return;
      }
      setCandidates(json.notes);
      if (json.notes.length === 0) setNotesError("没有找到笔记，换个关键词或稍后重试。");
      else showToast(`已获取 ${json.notes.length} 篇候选笔记`);
    } catch {
      setNotesError("获取笔记失败，请确认本地 rednote 服务在运行。");
      setCandidates([]);
    } finally {
      setLoadingNotes(false);
    }
  }

  // 解析粘贴的链接（客户端解析，需含 xsec_token），并标注哪些已评论过
  async function parseLinks() {
    const lines = linksText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const notes: EngageNote[] = [];
    let bad = 0;
    for (const line of lines) {
      const ref = parseNoteRef(line);
      if (!ref) {
        bad += 1;
        continue;
      }
      if (seen.has(ref.noteId)) continue;
      seen.add(ref.noteId);
      notes.push({ id: ref.noteId, xsecToken: ref.xsecToken, title: "", user: "", liked: "", type: "normal" });
    }
    resetDownstream();
    if (notes.length === 0) {
      setCandidates([]);
      setNotesError("没有解析到有效链接。请粘贴完整的小红书笔记链接（需带 xsec_token）。");
      return;
    }
    setNotesError(null);
    setLoadingNotes(true);
    // 查去重库，标注已评论过的（DB 不可用则降级为都未评论）
    let commentedSet = new Set<string>();
    try {
      const res = await fetch("/api/xiaohongshu/engage/commented", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteIds: notes.map((n) => n.id) }),
      });
      const json = (await res.json().catch(() => null)) as { commented?: string[] } | null;
      commentedSet = new Set(json?.commented ?? []);
    } catch {
      /* 降级：查不到就都当未评论 */
    }
    for (const n of notes) n.commented = commentedSet.has(n.id);
    setCandidates(notes);
    // 默认勾选：粘贴链接中「未评论过」的前 N 篇（跳过已评论，避免重复）
    const fresh = notes.filter((n) => !n.commented).slice(0, MAX_NOTES);
    setSelectedIds(new Set(fresh.map((n) => n.id)));
    setLoadingNotes(false);
    showToast(
      `已解析 ${notes.length} 篇${bad ? `（${bad} 行无效）` : ""}，选中 ${fresh.length} 篇` +
        (commentedSet.size ? `（跳过 ${commentedSet.size} 篇已评论）` : ""),
    );
  }

  // 生成一条评论（预览用）
  async function generateOne(note: EngageNote): Promise<Preview> {
    try {
      const res = await fetch("/api/xiaohongshu/engage/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noteId: note.id,
          xsecToken: note.xsecToken,
          title: note.title,
          styleHint,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; comment?: string; title?: string; error?: string }
        | null;
      if (!json?.success || !json.comment) {
        return {
          title: note.title,
          comment: "",
          status: "error",
          error: json?.error ?? "生成失败",
        };
      }
      return { title: json.title || note.title, comment: json.comment, status: "ready" };
    } catch {
      return { title: note.title, comment: "", status: "error", error: "网络连接失败" };
    }
  }

  // 步骤一：为所选笔记批量生成评论（串行 + 轻微间隔；无副作用）
  async function handleGenerate() {
    if (selectedNotes.length === 0) {
      showToast("请先勾选要互动的笔记");
      return;
    }
    setGenerating(true);
    setAwaitingConfirm(false);
    setResults({});
    abortRef.current = false;
    const targets = selectedNotes.slice(0, MAX_NOTES);
    setGenProgress({ done: 0, total: targets.length });
    // 先把所有目标标为 loading
    setPreviews(
      Object.fromEntries(
        targets.map((n) => [n.id, { title: n.title, comment: "", status: "loading" } as Preview]),
      ),
    );
    for (let i = 0; i < targets.length; i++) {
      if (abortRef.current) break;
      const note = targets[i];
      const p = await generateOne(note);
      setPreviews((prev) => ({ ...prev, [note.id]: p }));
      setGenProgress({ done: i + 1, total: targets.length });
      // 读正文会打小红书接口，稍作间隔降风控（最后一条不等）
      if (i < targets.length - 1 && !abortRef.current) await sleep(1200);
    }
    setGenerating(false);
  }

  // 重新生成单条
  async function regenerateOne(id: string) {
    const note = candidateById.get(id);
    if (!note || generating || executing) return;
    setPreviews((prev) => ({ ...prev, [id]: { ...prev[id], status: "loading" } }));
    const p = await generateOne(note);
    setPreviews((prev) => ({ ...prev, [id]: p }));
  }

  function editComment(id: string, comment: string) {
    setPreviews((prev) => ({
      ...prev,
      [id]: { ...prev[id], comment, status: comment.trim() ? "ready" : prev[id].status },
    }));
  }

  function removeFromBatch(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setPreviews((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // 待执行(批量) = 已勾选 + 有非空评论 + 既非成功也非「结果未知」。
  // unknown 表示评论可能已发出但结果不确定，绝不纳入自动批量重试(防重复评论)，只允许用户手动重试。
  const executable = useMemo(
    () =>
      selectedNotes.filter((n) => {
        const p = previews[n.id];
        if (!p || !p.comment.trim()) return false;
        const s = results[n.id]?.status;
        return s !== "ok" && s !== "unknown";
      }),
    [selectedNotes, previews, results],
  );

  // 执行单篇（真实写）。评论已发但拿不到确切结果 → 标 unknown，不自动重试。
  async function executeOne(note: EngageNote) {
    const comment = previews[note.id]?.comment.trim() ?? "";
    if (!comment) {
      setResults((prev) => ({ ...prev, [note.id]: { status: "error", error: "评论为空，已跳过" } }));
      return;
    }
    setResults((prev) => ({ ...prev, [note.id]: { status: "running" } }));
    try {
      const res = await fetch("/api/xiaohongshu/engage/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noteId: note.id,
          comment,
          likeComment,
          likeNote,
          // 传 token + 标题：成功后服务端据此把可打开的链接 + 标题记入去重库
          xsecToken: note.xsecToken,
          title: previews[note.id]?.title || note.title,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            success: boolean;
            outcome?: string;
            commentPosted?: boolean;
            commentLiked?: boolean;
            noteLiked?: boolean;
            recorded?: boolean;
            note?: string;
            error?: string;
          }
        | null;
      if (json?.success) {
        // 已成功评论：把这篇在候选列表标记为「已评论」，本次及以后都不再重复。
        setCandidates((prev) =>
          prev.map((c) => (c.id === note.id ? { ...c, commented: true } : c)),
        );
        const softNote =
          json.recorded === false
            ? [json.note, "未写入去重库(DB 不可用)"].filter(Boolean).join("；")
            : json.note;
        setResults((prev) => ({
          ...prev,
          [note.id]: {
            status: "ok",
            commentPosted: true,
            commentLiked: json.commentLiked,
            noteLiked: json.noteLiked,
            note: softNote,
          },
        }));
      } else if (json?.outcome === "unknown") {
        setResults((prev) => ({
          ...prev,
          [note.id]: { status: "unknown", error: json.error ?? "结果未知，可能已发布" },
        }));
      } else {
        // rednote 明确拒绝(rejected)或参数错误：评论没发出去，可安全重试。
        setResults((prev) => ({
          ...prev,
          [note.id]: { status: "error", noteLiked: json?.noteLiked, error: json?.error ?? "执行失败" },
        }));
      }
    } catch {
      // 拿不到响应：评论可能已发出，标 unknown，不自动重试。
      setResults((prev) => ({
        ...prev,
        [note.id]: { status: "unknown", error: "网络中断，无法确认是否已发布" },
      }));
    }
  }

  // 步骤二：确认后批量执行（串行 + 间隔）
  async function handleExecute() {
    if (executing) return; // 防重入(避免连点重复发)
    const targets = executable;
    if (targets.length === 0) {
      showToast("没有可执行的笔记（需先生成评论）");
      return;
    }
    setAwaitingConfirm(false);
    setExecuting(true);
    abortRef.current = false;
    setExecProgress({ done: 0, total: targets.length });
    setResults((prev) => {
      const next = { ...prev };
      for (const n of targets) next[n.id] = { status: "pending" };
      return next;
    });
    const delayMs = Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, delaySec)) * 1000;
    for (let i = 0; i < targets.length; i++) {
      if (abortRef.current) break;
      await executeOne(targets[i]);
      setExecProgress({ done: i + 1, total: targets.length });
      if (i < targets.length - 1 && !abortRef.current) await sleep(delayMs);
    }
    setExecuting(false);
  }

  // 手动重试单篇（用于 unknown/error）：用户确认「确实还没发」后才再发，防误重复。
  async function retryOne(id: string) {
    if (executing) return;
    const note = candidateById.get(id);
    if (!note) return;
    setExecuting(true);
    await executeOne(note);
    setExecuting(false);
  }

  function stopRun() {
    abortRef.current = true;
    showToast("已请求停止，将在当前一篇完成后停下");
  }

  function clearAll() {
    if (busy) return;
    setCandidates([]);
    resetDownstream();
    setKeyword("");
    setLinksText("");
    setNotesError(null);
  }

  const doneOk = Object.values(results).filter((r) => r.status === "ok").length;
  const doneErr = Object.values(results).filter((r) => r.status === "error").length;
  const doneUnknown = Object.values(results).filter((r) => r.status === "unknown").length;

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-3xl px-4 py-10">
        {/* 标题区 */}
        <header className="mb-8">
          <Link href="/" className="block text-xs text-gray-400 transition hover:text-gray-600">
            ← 工具箱
          </Link>
          <span className="mt-2 inline-flex items-center rounded-full bg-xhs/10 px-3 py-1 text-xs font-medium text-xhs">
            小红书 · 互动助手
          </span>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">小红书互动助手</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            批量为目标笔记生成「正向且相关」的评论(AI 读懂正文后再写)，预览确认后自动发评论、给自己这条评论点赞、并给帖子点赞。
          </p>
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
            ⚠️ 真实写操作，无法撤销。需本地 rednote 服务运行且浏览器已登录小红书。单批最多 {MAX_NOTES} 篇，已串行 +
            间隔以降低风控概率。请遵守小红书社区规范，勿刷屏。
          </p>
        </header>

        {/* 1. 选择笔记来源 */}
        <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">1. 选择要互动的笔记</h2>
          <div className="mt-3 inline-flex rounded-xl border border-gray-200 bg-white p-1">
            {(
              [
                ["search", "关键词搜索"],
                ["homefeed", "推荐信息流"],
                ["links", "粘贴链接"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSourceMode(m);
                  setCandidates([]);
                  resetDownstream();
                  setNotesError(null);
                }}
                aria-pressed={sourceMode === m}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                  sourceMode === m ? "bg-xhs text-white" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {sourceMode === "links" ? (
            <div className="mt-4">
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={"每行一个小红书笔记链接(需带 xsec_token)：\nhttps://www.xiaohongshu.com/explore/xxxx?xsec_token=..."}
                className="min-h-[120px] w-full resize-y rounded-xl border border-gray-200 p-3 text-sm outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40"
              />
              <button
                type="button"
                onClick={parseLinks}
                disabled={busy || !linksText.trim()}
                className="mt-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                解析链接
              </button>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              {sourceMode === "search" && (
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索关键词，如：stem opt 面试"
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40"
                />
              )}
              <label className="flex items-center gap-2 text-sm text-gray-600">
                翻页
                <select
                  value={pages}
                  onChange={(e) => setPages(Number(e.target.value))}
                  className="rounded-lg border border-gray-200 px-2 py-2 text-sm outline-none focus:border-xhs"
                >
                  {Array.from({ length: MAX_PAGES }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p}>
                      {p} 页
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={fetchNotes}
                disabled={busy || (sourceMode === "search" && !keyword.trim())}
                className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingNotes ? "获取中…" : sourceMode === "search" ? "搜索" : "获取推荐"}
              </button>
            </div>
          )}

          {notesError && <p className="mt-3 text-sm text-red-600">{notesError}</p>}

          {/* 候选列表 */}
          {candidates.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  已选 {selectedIds.size} / 上限 {MAX_NOTES}（共 {candidates.length} 篇
                  {commentedCount > 0 ? `，${commentedCount} 篇已评论过` : ""}）
                </span>
                <button
                  type="button"
                  disabled={busy || freshCount === 0}
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        candidates
                          .filter((n) => !n.commented)
                          .slice(0, MAX_NOTES)
                          .map((n) => n.id),
                      ),
                    )
                  }
                  className="text-xhs underline disabled:opacity-50"
                >
                  选中前 {Math.min(MAX_NOTES, freshCount)} 篇（跳过已评论）
                </button>
              </div>
              <ul className="max-h-72 space-y-1.5 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50/60 p-2">
                {candidates.map((n) => {
                  const checked = selectedIds.has(n.id);
                  return (
                    <li key={n.id}>
                      <label
                        className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm transition ${
                          checked ? "border-xhs bg-rose-50/60" : "border-transparent bg-white hover:border-gray-200"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={() => toggleSelect(n.id)}
                          className="mt-0.5 h-4 w-4 accent-xhs"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-gray-800">
                            {n.commented && (
                              <span className="mr-1 rounded bg-emerald-100 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-700">
                                已评论过
                              </span>
                            )}
                            {n.title || "（无标题 · 链接笔记）"}
                          </span>
                          <span className="mt-0.5 block text-xs text-gray-400">
                            {n.type === "video" ? "🎬 视频 · " : ""}
                            {n.user ? `@${n.user} · ` : ""}
                            {n.liked ? `❤️ ${n.liked}` : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {/* 2. 互动选项 */}
        {candidates.length > 0 && (
          <section className="mt-5 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900">2. 互动选项</h2>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="h-4 w-4 accent-xhs"
                  readOnly
                />
                发表评论（核心动作，必选；由 AI 生成正向且相关的内容）
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={likeComment}
                  disabled={busy}
                  onChange={(e) => setLikeComment(e.target.checked)}
                  className="h-4 w-4 accent-xhs"
                />
                给自己发的这条评论点赞
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={likeNote}
                  disabled={busy}
                  onChange={(e) => setLikeNote(e.target.checked)}
                  className="h-4 w-4 accent-xhs"
                />
                给帖子点赞
              </label>
            </div>

            <div className="mt-4">
              <label htmlFor="styleHint" className="text-sm font-medium text-gray-700">
                评论风格 / 额外说明（可选）
              </label>
              <input
                id="styleHint"
                type="text"
                value={styleHint}
                maxLength={MAX_STYLE_HINT}
                onChange={(e) => setStyleHint(e.target.value)}
                placeholder="如：以过来人的口吻、多点鼓励；留空则默认真诚正向"
                disabled={busy}
                className="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40 disabled:opacity-50"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-gray-700">每篇间隔</span>
              <input
                type="range"
                min={MIN_DELAY_SEC}
                max={MAX_DELAY_SEC}
                step={1}
                value={delaySec}
                disabled={busy}
                onChange={(e) => setDelaySec(Number(e.target.value))}
                className="h-1.5 w-40 cursor-pointer accent-xhs disabled:cursor-not-allowed"
              />
              <span className="text-xs text-gray-500">约 {delaySec} 秒 / 篇（间隔越大越不易被风控）</span>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleGenerate}
                disabled={busy || selectedNotes.length === 0}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating && (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                )}
                {generating
                  ? `生成评论中… ${genProgress.done}/${genProgress.total}`
                  : `① 生成评论（预览 ${selectedNotes.length} 篇，不发布）`}
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={busy}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-500 transition hover:border-red-200 hover:text-red-500 disabled:opacity-50"
              >
                清空
              </button>
            </div>
          </section>
        )}

        {/* 3. 预览 + 确认执行 */}
        {hasPreviews && (
          <section className="mt-5 rounded-2xl border-2 border-xhs/20 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">3. 预览评论并确认执行</h2>
              {(doneOk > 0 || doneErr > 0 || doneUnknown > 0) && (
                <span className="text-xs text-gray-500">
                  成功 {doneOk} · 失败 {doneErr}
                  {doneUnknown > 0 ? ` · 未知 ${doneUnknown}` : ""}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              每条评论都可直接编辑或重新生成。确认后才会真实发布 + 点赞。
            </p>

            <ul className="mt-4 space-y-3">
              {selectedNotes.map((n) => {
                const p = previews[n.id];
                if (!p) return null;
                const r = results[n.id];
                return (
                  <li key={n.id} className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                        {p.title || n.title || "（链接笔记）"}
                      </span>
                      <span className="shrink-0 text-xs">{execBadge(r)}</span>
                    </div>

                    {p.status === "loading" ? (
                      <p className="mt-2 text-sm text-gray-400">正在读正文并生成评论…</p>
                    ) : p.status === "error" ? (
                      <p className="mt-2 text-sm text-red-600">生成失败：{p.error}</p>
                    ) : (
                      <textarea
                        value={p.comment}
                        onChange={(e) => editComment(n.id, e.target.value)}
                        disabled={executing || r?.status === "ok"}
                        rows={2}
                        maxLength={MAX_COMMENT_CHARS}
                        className="mt-2 w-full resize-y rounded-lg border border-gray-200 bg-white p-2 text-sm outline-none transition focus:border-xhs focus:ring-1 focus:ring-xhs/40 disabled:opacity-60"
                      />
                    )}

                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                      <span className="text-gray-400">
                        {likeComment ? "💬评论 + 👍赞自己评论" : "💬评论"}
                        {likeNote ? " + ❤️赞帖子" : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => regenerateOne(n.id)}
                        disabled={generating || executing || r?.status === "ok"}
                        className="text-xhs underline disabled:opacity-40"
                      >
                        重新生成
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromBatch(n.id)}
                        disabled={generating || executing}
                        className="text-gray-400 underline hover:text-red-500 disabled:opacity-40"
                      >
                        移除
                      </button>
                      {r?.status === "error" && r.error && (
                        <span className="text-red-600">✗ {r.error}</span>
                      )}
                      {r?.status === "unknown" && (
                        <>
                          <span className="text-amber-600">⚠️ {r.error ?? "结果未知，可能已发布"}</span>
                          <button
                            type="button"
                            onClick={() => retryOne(n.id)}
                            disabled={generating || executing}
                            className="text-xhs underline disabled:opacity-40"
                          >
                            确认未发布，重试此条
                          </button>
                        </>
                      )}
                      {r?.status === "ok" && r.note && (
                        <span className="text-amber-600">注：{r.note}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* 执行控制 */}
            <div className="mt-5">
              {!awaitingConfirm ? (
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setAwaitingConfirm(true)}
                    disabled={generating || executing || executable.length === 0}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-xhs px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {executing
                      ? `执行中… ${execProgress.done}/${execProgress.total}`
                      : `② 确认批量执行（${executable.length} 篇）`}
                  </button>
                  {executing && (
                    <button
                      type="button"
                      onClick={stopRun}
                      className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      停止
                    </button>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p>
                    即将对 <b>{executable.length}</b> 篇笔记真实发布评论
                    {likeComment ? " + 给自己评论点赞" : ""}
                    {likeNote ? " + 给帖子点赞" : ""}，此操作<b>无法撤销</b>。确认继续？
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleExecute}
                      className="rounded-lg bg-xhs px-3 py-2 text-sm font-semibold text-white transition hover:bg-xhs-dark"
                    >
                      确认执行
                    </button>
                    <button
                      type="button"
                      onClick={() => setAwaitingConfirm(false)}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}

// 每篇执行状态徽标
function execBadge(r?: ExecResult): string {
  if (!r) return "";
  if (r.status === "pending") return "⏳ 排队中";
  if (r.status === "running") return "🔄 执行中";
  if (r.status === "ok") {
    const parts = ["✅ 已评论"];
    if (r.commentLiked) parts.push("👍");
    if (r.noteLiked) parts.push("❤️");
    return parts.join(" ");
  }
  if (r.status === "unknown") return "⚠️ 结果未知";
  return "❌ 失败";
}
