/**
 * 回答走 SSE 流式:面试里「第一个字多久出来」决定这功能好不好用,
 * 所以不等整段生成完再返回,一边生成一边推给页面。
 *
 * 协议很小,自己收发即可(不引 EventSource:那个不支持 POST 也不支持中途 abort):
 *   data: {"t":"delta","v":"..."}   增量文字
 *   data: {"t":"done"}             正常结束
 *   data: {"t":"error","v":"提示"}  失败(提示是给用户看的中文,不带内部细节)
 *
 * 这个文件两端共用:服务端用 sseResponse,页面用 readSse。只用 Web 标准 API。
 */

export type SseEvent = { t: "delta"; v: string } | { t: "done" } | { t: "error"; v: string };

const HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  // 关掉反代/CDN 的缓冲,否则流会被攒成一整块再发过来(那就白流式了)。
  "x-accel-buffering": "no",
} as const;

/** 把一个文字增量生成器包成 SSE 响应。tag 只用于服务端日志。 */
export function sseResponse(gen: AsyncGenerator<string>, tag: string): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // 对端已断开,后面不用再写了
        }
      };

      try {
        for await (const delta of gen) {
          if (delta) send({ t: "delta", v: delta });
          if (closed) break;
        }
        send({ t: "done" });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name ?? "Unknown";
        // 用户主动中断(换个问题/点了停)不是错误,不用报给页面。
        if (name !== "APIUserAbortError" && name !== "AbortError") {
          console.error(`[ai-interview:${tag}] 流式生成失败`, { name });
          send({ t: "error", v: "生成失败,请重试。" });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      }
    },
    cancel() {
      closed = true;
      void gen.return?.(undefined as never);
    },
  });

  return new Response(stream, { headers: HEADERS });
}

/**
 * 页面侧:读一个 SSE 响应,逐个事件回调。返回累积的完整文本。
 * 抛错只在网络层面(fetch 断了);模型侧的失败以 error 事件形式回调。
 */
export async function readSse(res: Response, onEvent: (event: SseEvent) => void): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("没有响应流");
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const raw = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
      if (!raw.startsWith("data:")) continue;
      try {
        const event = JSON.parse(raw.slice(5).trim()) as SseEvent;
        if (event.t === "delta") full += event.v;
        onEvent(event);
      } catch {
        /* 半个包/坏包直接跳过 */
      }
    }
  }
  return full;
}
