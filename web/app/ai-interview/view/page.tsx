"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { splitLayered } from "@/lib/aiInterview/layered";
import { EMPTY_LIVE_STATE, MODE_LABELS, type LiveState } from "@/lib/aiInterview/schema";
import { COMMAND_TIMEOUT_MS, isStale, reconnectDelayMs } from "@/lib/aiInterview/viewState";

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
  /**
   * 手机 → Mac 的命令。
   *
   * 为什么要在手机上放截图按钮:算法题的时候人是盯着手机看答案的,而截图快捷键在
   * Mac 上 —— 题目看得见、键按不到。点一下这里,命令搭桌面端下一次推帧(150ms 一次)
   * 的响应回去执行,所以从点到 Mac 动作最多差一帧。
   *
   * shots 是「我按了几下截图」的本地计数,不是 Mac 的确认 —— 真正的确认是答案出现。
   * 发送之后归零。
   */
  /**
   * 「完美答案」当前是不是展开着。
   *
   * 默认看第一版:面试时正在念的那一版不能被后台跑完的结果**悄悄换掉** ——
   * 眼睛跟着的文字突然变了比没有更糟。所以要人主动点。
   */
  const [showPerfect, setShowPerfect] = useState(false);
  const [shots, setShots] = useState(0);
  const [cmdBusy, setCmdBusy] = useState<string | null>(null);
  const [cmdNote, setCmdNote] = useState<string | null>(null);

  const sendCommand = useCallback(async (type: string) => {
    const k = new URLSearchParams(window.location.search).get("k") || "";
    if (!k) return;
    setCmdBusy(type);
    setCmdNote(null);
    try {
      // 必须有超时:按钮的 disabled 只在 finally 里清,一个永不 settle 的 fetch
      // (隧道半死不活时最常见)会把三个按钮永久变灰 —— 而那正是最需要
      //「回答这句」的时候。
      const res = await fetch("/api/ai-interview/live/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ k, type }),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !data?.success) {
        setCmdNote(data?.error || "没发出去");
        return;
      }
      if (type === "takeScreenshot") {
        setShots((n) => n + 1);
        setCmdNote("已让 Mac 截一张");
      } else if (type === "processScreenshots") {
        setShots(0);
        setCmdNote("已送去解题,等答案");
      } else if (type === "whatToAnswer") {
        setCmdNote("已让 Mac 回答这句,等答案");
      } else {
        setShots(0);
        setCmdNote("已清空");
      }
    } catch {
      setCmdNote("网络不通");
    } finally {
      setCmdBusy(null);
    }
  }, []);

  /* ---- 连接 ---- */
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get("k") || "";
    if (!k) {
      setConn("denied");
      return;
    }
    const url = `/api/ai-interview/live/stream?k=${encodeURIComponent(k)}`;
    let es: EventSource | null = null;
    let timer: number | null = null;
    let attempt = 0;
    let stopped = false;

    /**
     * 配对码到底是不是错的?
     *
     * `readyState === CLOSED` 不能直接当成「没有配对」:服务端返回任何非 200 都会让
     * 浏览器**永久**关掉 EventSource,而这包括隧道重启、Cloudflare 5xx、切网时的一瞬。
     * 之前就是这么判的 —— 网络抖一下,手机永远停在「没有配对」,提示还指错方向
     * (人会去翻配对码,而其实只要重连)。所以这里真的去问一次状态码:
     * 只有 403 才是配对问题,其余一律重连。
     */
    const isDenied = async (): Promise<boolean> => {
      const ctl = new AbortController();
      // 只要状态码,不要消费这条 SSE 流,所以拿到响应头就掐掉。
      const kill = window.setTimeout(() => ctl.abort(), 4_000);
      try {
        const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        ctl.abort();
        return res.status === 403;
      } catch {
        return false; // 探测本身失败 = 网络问题,不是配对问题
      } finally {
        window.clearTimeout(kill);
      }
    };

    const connect = () => {
      if (stopped) return;
      es = new EventSource(url);
      es.onopen = () => {
        attempt = 0; // 连上了就把退避清零,下次抖动仍然从 1 秒开始重试
        setConn("open");
      };
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
        if (stopped) return;
        if (es && es.readyState !== EventSource.CLOSED) {
          // 浏览器自己会重连,别插手。
          setConn("lost");
          return;
        }
        setConn("lost");
        es?.close();
        es = null;
        void isDenied().then((denied) => {
          if (stopped) return;
          // 403 不是终态。配对码是每个 web 进程重新生成的(dev 重启一次就变),
          // 桌面端会自己取到新码继续推 —— 只有手机会永远停在「未配对」。
          // 所以照样重试,只是把间隔拉长。
          if (denied) setConn("denied");
          attempt += 1;
          const wait = reconnectDelayMs({ denied, attempt });
          timer = window.setTimeout(connect, wait);
        });
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      es?.close();
    };
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
  }, [state.answer, showPerfect]);

  // 新一轮答案开始(桌面端把 perfectState 复位成 none/running)就收起来,
  // 否则会拿上一题的「完美答案」盖住这一题。
  useEffect(() => {
    if (state.perfectState === "none" || state.perfectState === "running") setShowPerfect(false);
  }, [state.perfectState]);

  const shown = showPerfect && state.perfectAnswer ? state.perfectAnswer : state.answer;
  const layered = splitLayered(shown);
  // 只有「Mac 那边正在面试」时,长时间没新帧才算异常;没开始时本来就没人推,别误报。
  // 同时看两个时钟:本机收到时间,和桌面端盖在帧上的 state.at。
  // 只看前者的话,刚打开页面时 SSE 补的那一帧(可能是几小时前桌面端死掉时留下的)
  // 会被显示成跳动的绿色「进行中」。
  const stale = isStale({
    live: state.live,
    frameAt: state.at,
    receivedAt,
    now,
    staleAfterMs: STALE_MS,
  });
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
        {state.sttFailed > 0 && (
          <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-semibold text-rose-300">
            ⚠️ 采集断过 {state.sttFailed} 次
          </span>
        )}
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

      {/*
        桌面端报上来的失败原因。
        在这之前,所有失败在手机上长得一模一样 —— 就是「屏幕不动了」:答案生成失败、
        重试耗尽、发布权被网页版抢走、采集中断,全部无声。面试进行中最没用的信息就是
        「它好像卡住了」,因为你无法据此决定要不要开口。
      */}
      {state.error && (
        <div className="border-b border-amber-900/60 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
          ⚠️ {state.error}
        </div>
      )}

      {/*
        手动兜底。自动回答要等桌面端收到 final 转写,而「问题已经显示出来了、答案却
        没动」是这套东西最难受的失败模式 —— 面试官在等你,你在等一个不会来的事件。
        这个按钮不看任何自动判断,点了就等于在 Mac 上按 ⌘1。
        放在最上面、占满一行:需要它的时候人是慌的,不该还要瞄准。
      */}
      {conn !== "denied" && (
        <div className="border-b border-slate-800 px-4 pt-2 text-sm">
          <button
            onClick={() => void sendCommand("whatToAnswer")}
            disabled={cmdBusy !== null}
            className="w-full rounded-lg border border-sky-600 bg-sky-700 px-3 py-2.5 font-semibold text-white active:bg-sky-600 disabled:opacity-50"
          >
            💬 回答这句
          </button>
        </div>
      )}

      {/* 截图解题:算法题时人在手机前,截图键在 Mac 上 —— 这两个按钮把键搬过来。 */}
      {conn !== "denied" && (
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-sm">
          <button
            onClick={() => void sendCommand("takeScreenshot")}
            disabled={cmdBusy !== null}
            className="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-medium text-slate-100 active:bg-slate-700 disabled:opacity-50"
          >
            📷 截图{shots > 0 ? ` · ${shots}` : ""}
          </button>
          <button
            onClick={() => void sendCommand("processScreenshots")}
            disabled={cmdBusy !== null}
            className="flex-1 rounded-lg border border-emerald-600 bg-emerald-700 px-3 py-2.5 font-medium text-white active:bg-emerald-600 disabled:opacity-50"
          >
            ➤ 发送解题
          </button>
          {shots > 0 && (
            <button
              onClick={() => void sendCommand("resetCancel")}
              disabled={cmdBusy !== null}
              className="rounded-lg border border-slate-700 px-2.5 py-2.5 text-slate-400 active:bg-slate-800 disabled:opacity-50"
            >
              清空
            </button>
          )}
        </div>
      )}
      {cmdNote && (
        <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-1.5 text-xs text-slate-400">
          {cmdNote}
        </div>
      )}

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
            {/*
              实时字幕:对方此刻正在说的那句。和上面那行是两件事 ——
              上面是「这个答案是针对哪一问生成的」(必须稳定),这里是「现在在说什么」(一直变)。
              桌面端的悬浮窗本来就这么分,手机上以前没有,所以对方说话的那十几秒屏幕是死的,
              人不知道是没听见还是还没说完。斜体 + 暗一档,视觉上和已定稿的问题区分开。
            */}
            {state.partial && state.partial !== state.question && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[13px] italic leading-relaxed text-slate-500">
                <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                <span>{state.partial}</span>
              </p>
            )}
          </div>

          {/* 该说的话 */}
          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>{showPerfect ? "完美答案" : state.label || "建议这样说"}</span>
              {/*
                两阶段回答的阶段标。上游本来就在面试官说完之前先算一版(maybeSpeculate),
                只是结果进了缓存不给人看 —— 现在显形了,就必须让人**一眼看出这版还会变**,
                否则照着念到一半被换掉比不给还糟。
                正式答案不加标:没有标记 = 这就是最终版。
              */}
              {!showPerfect && state.answerStage === "draft" && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold normal-case text-amber-400 ring-1 ring-amber-500/30">
                  临时 · 还在听
                </span>
              )}
              {state.streaming && <span className="text-emerald-400">生成中</span>}

              {/*
                「完美答案」= 桌面端在后台把代码丢进沙箱跑测试用例的结果。
                四态:没在验 → 不显示;正在跑 → 置灰;第一版就全过 → 绿勾(没东西可切);
                有纠正版 → 高亮可点。
                刻意做成手动切换而不是自动替换:面试时正在念的文字被悄悄换掉比不换更糟。
              */}
              {state.perfectState !== "none" && (
                <button
                  onClick={() => state.perfectState === "ready" && setShowPerfect((v) => !v)}
                  disabled={state.perfectState !== "ready"}
                  className={
                    state.perfectState === "ready"
                      ? `ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold normal-case ${
                        showPerfect
                          ? "bg-emerald-500 text-slate-900"
                          : "bg-emerald-600/90 text-white ring-1 ring-emerald-300 animate-pulse"
                      }`
                      : "ml-auto rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium normal-case text-slate-500"
                  }
                >
                  {state.perfectState === "running" && "验证中…"}
                  {state.perfectState === "skipped" && "⚠ 未验证"}
                  {state.perfectState === "already" && "✓ 用例全过"}
                  {state.perfectState === "ready" && (showPerfect ? "← 看第一版" : "完美答案")}
                </button>
              )}
            </div>

            {/* 验证结论:哪里错了 / 几个用例过了。人要照着念,得知道这版的可信度。 */}
            {state.perfectNote && state.perfectState !== "none" && (
              <div
                className={`mb-2 rounded-md px-2 py-1 text-[11px] ${
                  state.perfectState === "ready"
                    ? "bg-emerald-950/60 text-emerald-300"
                    : "bg-slate-800/60 text-slate-400"
                }`}
              >
                {state.perfectNote}
              </div>
            )}
            <div
              ref={answerRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className={`flex-1 overflow-y-auto pb-4 font-medium leading-[1.6] ${
                !showPerfect && state.answerStage === "draft" ? "text-slate-400" : "text-white"
              }`}
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
              {!shown && (
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
