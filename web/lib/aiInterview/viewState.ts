/**
 * 副屏页面的纯判断逻辑。
 *
 * 从 app/ai-interview/view/page.tsx 里抽出来,只为一个原因:那些判断决定了面试
 * 中途「屏幕不动了」时人看到什么,而它们原来长在组件里 —— vitest 只收
 * `web/lib/**`,仓库里也没装 jsdom,所以这套东西一行测试都没有。
 *
 * 这里的函数都是纯的:输入是状态,输出是「该显示什么 / 该不该重连」。
 */

/** SSE 连接的三种状态。 */
export type Conn = "open" | "lost" | "denied";

/**
 * 一帧多旧算「不新鲜」。
 *
 * 桌面端闲时也有 2.5 秒心跳,所以超过它几倍还没新帧,就是那一端出事了。
 */
export const STALE_AFTER_MS = 12_000;

/**
 * 这一帧是不是已经不能信了。
 *
 * 关键在于**同时**看两个时钟:
 *  - `receivedAt`:本机收到的时间。手机断网时它会停,但页面刚打开时,SSE 会先
 *    补一帧「当前快照」——那帧可能是几小时前桌面端死掉时留下的,而 receivedAt 是
 *    「刚刚」,于是一场早就结束的面试会显示成正在进行。
 *  - `state.at`:桌面端盖的时间戳。它才是「那一端什么时候还活着」。
 *
 * 两个都得新,才算新鲜。
 */
export function isStale(input: {
  live: boolean;
  frameAt: number;
  receivedAt: number;
  now: number;
  staleAfterMs?: number;
}): boolean {
  const limit = input.staleAfterMs ?? STALE_AFTER_MS;
  if (!input.live) return false;              // 没在进行中,谈不上新不新鲜
  if (input.now - input.receivedAt > limit) return true;
  // frameAt 为 0 表示还没收到过真帧(初始快照),不据此判定。
  if (input.frameAt > 0 && input.now - input.frameAt > limit) return true;
  return false;
}

/**
 * 断线之后该怎么办。
 *
 * `denied` 曾经是**终态**:一旦判成没配对就再也不重试。而配对码是每个 web 进程
 * 重新生成的(dev 重启一次就变),桌面端会自己重新取到新码继续推 —— 只有手机
 * 永远停在「未配对」。所以 403 之后仍然要重试,只是间隔拉长:配对码变了是人
 * 能修的事(重新扫码),但网络恢复后自己接上更重要。
 */
export function reconnectDelayMs(input: {
  denied: boolean;
  attempt: number;
  maxMs?: number;
  deniedMs?: number;
}): number {
  if (input.denied) return input.deniedMs ?? 15_000;
  const max = input.maxMs ?? 8_000;
  const n = Math.max(1, input.attempt);
  return Math.min(1_000 * 2 ** (n - 1), max);
}

/** 顶部那一行状态文字。把所有分支收在一个地方,免得散在 JSX 里各说各话。 */
export function connLabel(input: {
  conn: Conn;
  live: boolean;
  stale: boolean;
  sourceDown: boolean;
}): string {
  if (input.conn === "denied") return "未配对";
  if (input.conn === "lost") return "重连中";
  if (input.stale) return "Mac 端已暂停";
  if (!input.live) return "未开始";
  if (input.sourceDown) return "⚠️ 采集中断,重连中";
  return "进行中";
}

/**
 * 手机上按钮的请求超时。
 *
 * sendCommand 原来没有超时,而 `cmdBusy` 只在 finally 里清 —— 一个永远不 settle
 * 的 fetch(隧道半死不活时最常见)会让三个按钮一直是灰的,而这恰恰是用户最需要
 * 「回答这句」的时候。
 */
export const COMMAND_TIMEOUT_MS = 8_000;
