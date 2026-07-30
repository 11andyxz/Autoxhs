import type { NextRequest } from "next/server";

import { checkCode, liveSnapshot, subscribeLive } from "@/lib/aiInterview/liveHub";
import type { LiveState } from "@/lib/aiInterview/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 这是个长连接,不能被当成普通请求提前掐掉 */
export const maxDuration = 3600;

/** 心跳:iOS Safari / 中间设备会掐掉长时间没数据的连接 */
const PING_MS = 15_000;

/**
 * 副屏订阅:连上先补一帧当前状态,之后主页面每推一帧就转发一帧。
 * 用 EventSource(GET)接,浏览器自带断线重连。
 */
export async function GET(req: NextRequest) {
  if (!checkCode(req.nextUrl.searchParams.get("k"))) {
    return new Response("forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (state: LiveState) => write(`data: ${JSON.stringify(state)}\n\n`);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (ping) clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      };

      send(liveSnapshot());
      unsubscribe = subscribeLive(send);
      ping = setInterval(() => {
        write(": ping\n\n");
        if (closed) cleanup();
      }, PING_MS);

      // 副屏关掉页面 / 断网 → 立刻退订,别把死连接留在 hub 里。
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
