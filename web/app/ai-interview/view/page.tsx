"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { splitLayered } from "@/lib/aiInterview/layered";
import { EMPTY_LIVE_STATE, MODE_LABELS, type LiveState } from "@/lib/aiInterview/schema";

/**
 * 副屏视图:手机 / iPad / 第二显示器上只读地看「当前问题 + 该说的话」。
 *
 * 数据不是轮询来的 —— 它订阅本机 server 的同一条 SSE(见 api/ai-interview/live/stream),
 * Mac 上一个字一个字出现的同时,这里也一个字一个字出现。
 *
 * 地址形如 http://192.168.x.x:3100/ai-interview/view?k=配对码,
 * 配对码在 Mac 的主页面上显示(「副屏 / 手机查看」那一块)。
 */

const KIND_LABEL: Record<string, string> = {
  behavioral: "行为题",
  technical: "技术题",
  coding: "算法题",
  logistics: "流程/待遇",
  smalltalk: "寒暄",
  unclear: "没听清",
};

/** 超过这么久没收到新帧,就提示「Mac 端可能停了」 */
const STALE_MS = 10_000;
const SIZES = [18, 22, 26, 32, 38];
const SIZE_KEY = "axs.aiInterview.viewFontSize";

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function LiveViewPage() {
  const [state, setState] = useState<LiveState>(EMPTY_LIVE_STATE);
  const [conn, setConn] = useState<"connecting" | "open" | "denied" | "lost">("connecting");
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [sizeIdx, setSizeIdx] = useState(2);
  const [showTranscript, setShowTranscript] = useState(true);
  const answerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  /* ---- 连接 ---- */
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get("k") || "";
    if (!k) {
      setConn("denied");
      return;
    }
    const es = new EventSource(`/api/ai-interview/live/stream?k=${encodeURIComponent(k)}`);
    es.onopen = () => setConn("open");
    es.onmessage = (e) => {
      try {
        setState(JSON.parse(e.data) as LiveState);
        setReceivedAt(Date.now());
        setConn("open");
      } catch {
        /* 坏包跳过 */
      }
    };
    es.onerror = () => {
      // 配对码不对 → 服务端 403,EventSource 直接关闭不再重连。
      setConn(es.readyState === EventSource.CLOSED ? "denied" : "lost");
    };
    return () => es.close();
  }, []);

  /* ---- 本地走时钟(空闲时不会有新帧,但计时得继续动) ---- */
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  /* ---- 字号记住上次选的 ---- */
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(SIZE_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < SIZES.length) setSizeIdx(saved);
  }, []);
  const setSize = useCallback((idx: number) => {
    const next = Math.min(SIZES.length - 1, Math.max(0, idx));
    setSizeIdx(next);
    window.localStorage.setItem(SIZE_KEY, String(next));
  }, []);

  /* ---- 尽量别让手机自动锁屏(非 HTTPS 下这个 API 可能没有,拿不到就算了) ---- */
  useEffect(() => {
    type WakeLock = { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLock) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    wakeLock
      .request("screen")
      .then((s) => {
        sentinel = s;
      })
      .catch(() => {});
    return () => void sentinel?.release().catch(() => {});
  }, []);

  /* ---- 答案区跟到最新(除非用户自己往上翻了) ---- */
  useEffect(() => {
    const box = answerRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [state.answer]);

  const layered = splitLayered(state.answer);
  // 只有「Mac 那边正在面试」时,长时间没新帧才算异常;没开始时本来就没人推,别误报。
  const stale = state.live && receivedAt > 0 && now - receivedAt > STALE_MS;
  const elapsed = state.live && receivedAt ? state.elapsedMs + (now - receivedAt) : state.elapsedMs;
  const font = SIZES[sizeIdx];

  return (
    <main
      className="flex min-h-screen flex-col bg-slate-950 text-slate-100"
      // 避开灵动岛/刘海与底部横条:横屏时灵动岛在左边,会压住「建议这样说」和答案的第一列(实测)。
      // 竖屏、没有灵动岛的机型上这些值是 0,布局不受影响。
      style={{
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {/* 顶栏 */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              conn === "open" && state.live && !stale
                ? "animate-pulse bg-emerald-400"
                : conn === "denied"
                  ? "bg-rose-500"
                  : "bg-slate-500"
            }`}
          />
          {conn === "denied"
            ? "未配对"
            : conn === "lost"
              ? "重连中"
              : stale
                ? "Mac 端已暂停"
                : state.live
                  ? state.sourceDown
                    ? "⚠️ 采集中断,重连中"
                    : "进行中"
                  : "未开始"}
        </span>
        <span className="font-mono">{fmtClock(elapsed)}</span>
        {state.company && <span className="truncate">{state.company}</span>}
        <span>{MODE_LABELS[state.mode]?.name}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="rounded border border-slate-700 px-2 py-0.5 text-slate-300"
          >
            {showTranscript ? "隐藏字幕" : "显示字幕"}
          </button>
          <button
            onClick={() => setSize(sizeIdx - 1)}
            className="rounded border border-slate-700 px-2 py-0.5 text-slate-300"
          >
            A−
          </button>
          <button
            onClick={() => setSize(sizeIdx + 1)}
            className="rounded border border-slate-700 px-2 py-0.5 text-slate-300"
          >
            A+
          </button>
        </div>
      </header>

      {conn === "denied" ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm leading-relaxed text-slate-400">
          <div>
            <p className="text-base text-slate-200">没有配对</p>
            <p className="mt-2">
              地址里要带上配对码,形如
              <br />
              <code className="text-slate-300">…/ai-interview/view?k=xxxxxx</code>
              <br />
              配对码在 Mac 上「AI 辅助面试」页面的「副屏 / 手机查看」里。
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* 当前问题 */}
          <div className="border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>听到的问题</span>
              {state.questionKind && (
                <span className="rounded-full bg-slate-800 px-2 py-0.5 normal-case text-slate-300">
                  {KIND_LABEL[state.questionKind] || state.questionKind}
                  {state.confidence ? ` · ${Math.round(state.confidence * 100)}%` : ""}
                </span>
              )}
            </div>
            <p className="mt-1 text-[15px] leading-relaxed text-slate-300">
              {state.question || "等对方提问…"}
            </p>
          </div>

          {/* 该说的话 */}
          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>{state.label || "建议这样说"}</span>
              {state.streaming && <span className="text-emerald-400">生成中</span>}
            </div>
            <div
              ref={answerRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className="flex-1 overflow-y-auto pb-4 font-medium leading-[1.6] text-white"
              style={{ fontSize: `${font}px` }}
            >
              {/* 中文速读放在最上面:扫一眼抓逻辑,再看下面的英文照着说 */}
              {layered.gist && (
                <p
                  className="mb-3 whitespace-pre-wrap rounded-lg bg-slate-800/70 px-3 py-2 leading-relaxed text-sky-200"
                  style={{ fontSize: `${Math.round(font * 0.72)}px` }}
                >
                  {layered.gist}
                </p>
              )}
              {layered.speak && <p className="whitespace-pre-wrap">{layered.speak}</p>}
              {layered.extra && (
                <p className="mt-3 text-slate-500" style={{ fontSize: `${Math.round(font * 0.5)}px` }}>
                  还可以补:{layered.extra}
                </p>
              )}
              {layered.plain && <p className="whitespace-pre-wrap">{layered.plain}</p>}
              {!state.answer && (
                <span className="text-base font-normal text-slate-500">
                  对方一提问,这里就会出现可以直接照着说的话。
                </span>
              )}
              {state.streaming && <span className="animate-pulse text-slate-500">▍</span>}
            </div>
          </div>

          {/* 最近字幕 */}
          {showTranscript && (
            <div className="max-h-[26vh] overflow-y-auto border-t border-slate-800 bg-slate-900/60 px-4 py-2">
              {state.transcript.length === 0 && (
                <p className="text-xs text-slate-600">还没听到内容</p>
              )}
              {state.transcript.map((t, i) => (
                <p key={`${t.at}-${i}`} className="text-xs leading-relaxed">
                  <span
                    className={
                      t.role === "interviewer"
                        ? "text-sky-400"
                        : t.role === "assistant"
                          ? "text-violet-400"
                          : "text-slate-500"
                    }
                  >
                    {t.role === "interviewer" ? "面试官" : t.role === "me" ? "我" : "AI"}:
                  </span>{" "}
                  <span className="text-slate-400">{t.text}</span>
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
