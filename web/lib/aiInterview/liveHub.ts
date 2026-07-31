import { randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";

import { EMPTY_LIVE_STATE, type LiveState } from "./schema";

/**
 * 副屏推流的内存 hub(只在服务端跑)。
 *
 * Mac 上那个主页面每有变化就 POST 一帧快照进来,副屏(手机 / iPad / 第二显示器)通过
 * SSE 订阅同一个 hub —— 全程在本机内存里过一手,不落库、不轮询,手机上的字和 Mac 上
 * 基本同时出现(局域网一跳,几十毫秒)。
 *
 * 挂在 globalThis:dev 下每次 HMR 都会重新求值本模块,普通模块级变量会被重置,
 * 已连上的副屏就成了孤儿(和连接池同一个坑,见 serviceFee/db.ts)。
 *
 * 注意这是**单进程**的内存广播:本机 next dev / next start 都是一个进程,没问题;
 * 部署到 Serverless(多实例)就不成立 —— 那种场景要换成走库/外部中转。
 */

type Subscriber = (state: LiveState) => void;

/**
 * 当前有权往副屏写的那个页面。
 *
 * 为什么需要:副屏通道只有一个「当前状态」槽位,而 Mac 上很容易同时留着两个 Autoxhs 页面
 * (旧标签页没关、或刷新出了新的一个)。两个页面各自每 2.5 秒推一次心跳,谁最后写的就显示谁,
 * 手机上就会在「新面试」和「旧面试」之间来回跳(2026-07-29 实测)。
 * 规则:只认最新打开的那个页面;旧页面的帧直接忽略,并在响应里告诉它「你被接管了,别再推」。
 */
type Owner = { id: string; startedAt: number; lastAt: number; live: boolean };

/** 当前发布者静默这么久就让位(页面被关掉 / 断网了) */
const OWNER_STALE_MS = 8_000;

type Hub = {
  state: LiveState;
  subscribers: Set<Subscriber>;
  /** 配对码:副屏地址里的 k=,一个进程内固定不变(手机可以存书签) */
  code: string;
  owner: Owner | null;
  /**
   * 手机 → 桌面端的命令队列。
   *
   * 副屏本来是单向的(桌面推,手机看),但算法题时手机上看得见题目、按不到快捷键 ——
   * 人在手机前面,截图键在 Mac 上。所以副屏上放「截图 / 发送」两个按钮,点了就往这里排一条,
   * 桌面端下一次推帧(150ms 一次)的响应里把队列带回去执行。
   *
   * 为什么复用推帧的响应而不是新开一条轮询:那条通道本来就在跑、本来就 150ms 一次,
   * 手机点一下到 Mac 动作之间最多差一帧,而且不用再管一个连接的生死。
   *
   * 队列有上限:副屏断网时用户很可能连点好几下,不能让它无限堆着等某次重连一起爆发。
   */
  commands: LiveCommand[];
};

/** 手机能发的动作。名字直接对应 natively 的 global-shortcut action。 */
export type LiveCommandType =
  | "takeScreenshot"
  | "processScreenshots"
  | "resetCancel"
  /**
   * 「回答这句」—— 手动兜底,对应 Mac 上的 ⌘1。
   *
   * 自动触发依赖桌面端收到 final 转写;任何一条它没收到 final 的路径(转写只来了
   * partial、STT 掉线重连、触发被吃掉)都会让人对着一个不出答案的屏幕干等,而面试
   * 是不能重来的。所以留一个不依赖任何自动判断的入口:人看到问题了,自己点。
   */
  | "whatToAnswer";

export type LiveCommand = { id: string; type: LiveCommandType; at: number };

/** 攒着没被取走的命令上限,超了丢最旧的 */
const MAX_PENDING_COMMANDS = 6;

const globalForHub = globalThis as unknown as { __autoxhsLiveHub?: Hub };

/** 去掉容易看错的字符(0/o/1/l/i),6 位 ≈ 20 亿种,手机上也就多敲几下 */
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

function newCode(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function hub(): Hub {
  if (!globalForHub.__autoxhsLiveHub) {
    globalForHub.__autoxhsLiveHub = {
      state: { ...EMPTY_LIVE_STATE },
      subscribers: new Set(),
      code: newCode(),
      owner: null,
      commands: [],
    };
  }
  const h = globalForHub.__autoxhsLiveHub;
  // 挂在 globalThis 上的对象会跨 HMR / 跨模块重载存活,所以它可能是**旧版本的
  // 这段代码**建出来的、还没有后来新加的字段。`commands` 就是这么炸过一次:
  // 加完字段后 dev server 没重启,已经存在的 hub 上 commands 是 undefined,
  // enqueueLiveCommand 里的 push 直接 500 —— 而且报错点离真正的原因很远。
  // 新字段一律在这里补一次。
  if (!Array.isArray(h.commands)) h.commands = [];
  return h;
}

/**
 * 手机点了按钮:排一条命令,等桌面端下次推帧时取走。
 * 返回队列长度,让手机能显示「还有几条没被执行」。
 */
export function enqueueLiveCommand(type: LiveCommandType): number {
  const h = hub();
  h.commands.push({ id: `${Date.now().toString(36)}-${randomInt(1e6).toString(36)}`, type, at: Date.now() });
  if (h.commands.length > MAX_PENDING_COMMANDS) {
    h.commands = h.commands.slice(-MAX_PENDING_COMMANDS);
  }
  return h.commands.length;
}

/** 桌面端取走并清空。取走即视为已投递 —— 重发一次截图比漏一次更烦人。 */
export function drainLiveCommands(): LiveCommand[] {
  const h = hub();
  if (h.commands.length === 0) return [];
  const out = h.commands;
  h.commands = [];
  return out;
}

/** 副屏配对码(进程内固定) */
export function liveCode(): string {
  return hub().code;
}

export function checkCode(k: string | null): boolean {
  return !!k && k === hub().code;
}

/** 当前快照(副屏刚连上时先补一帧) */
export function liveSnapshot(): LiveState {
  return hub().state;
}

/** 有几个副屏正连着(主页面上显示「副屏已连接 N」) */
export function viewerCount(): number {
  return hub().subscribers.size;
}

/**
 * 推一帧:先按归属权判断这个页面还有没有资格写,有资格才盖版本号并广播。
 * accepted=false 表示这个页面已被更新的页面接管(调用方应停止推流)。
 */
export function publishLive(
  publisher: { id: string; startedAt: number },
  partial: Omit<LiveState, "v" | "at">,
): { state: LiveState; accepted: boolean } {
  const h = hub();
  const now = Date.now();
  const owner = h.owner;

  const take = () => {
    h.owner = {
      id: publisher.id,
      startedAt: publisher.startedAt,
      lastAt: now,
      live: partial.live === true,
    };
  };

  if (!owner || owner.id === publisher.id) {
    take();
  } else if (now - owner.lastAt > OWNER_STALE_MS) {
    // 原主人已经没声了(标签页被关了 / 进程死了 / 断网)。
    take();
  } else if (owner.live && partial.live !== true) {
    // 正在进行的一场面试,不会被一个「闲着的」发布者顶掉。
    //
    // 2026-07-31 真事:桌面端 natively 正在面试、手机上正常看着答案,用户在 Mac 上
    // 打开了网页版 /ai-interview —— 那个页面一挂载就取配对码、并且从此每隔几秒推一帧
    // 心跳,哪怕它自己一场面试都没开(live:false)。它的 startedAt 是「页面打开时间」,
    // 必然比桌面端的「会议开始时间」新,于是按纯粹的「新的赢」规则它当场夺权,桌面端
    // 退避 15 秒后继续输,手机上直接变成「Mac 端已暂停」—— 面试进行到一半。
    //
    // 「新的赢」这条规则本身没错,但它的适用范围是两个同类发布者之间(两个网页标签页,
    // 见下面那条分支)。跨类别时,「谁真的在面试」比「谁开得晚」重要得多。
    return { state: h.state, accepted: false };
  } else if (publisher.startedAt > owner.startedAt || (partial.live === true && !owner.live)) {
    // 更晚打开的页面接管(两个标签页之间的原有规则);
    // 或者对方真的开了一场面试,而当前这个只是闲着 —— 那就该让位。
    take();
  } else {
    return { state: h.state, accepted: false };
  }

  const state: LiveState = { ...partial, v: h.state.v + 1, at: now };
  h.state = state;
  // 写失败的订阅者直接摘掉。原来的注释说「它自己的 SSE 会清理」—— 但那条路只在
  // 请求 abort 时触发,而 controller 已经关闭的情况下 enqueue 抛错是不会带来
  // abort 的,于是这个死订阅者永远留在集合里:每帧都抛一次异常,viewerCount()
  // 也一直虚高(主页面上显示「副屏已连接 N」)。
  const dead: Subscriber[] = [];
  for (const send of h.subscribers) {
    try {
      send(state);
    } catch {
      dead.push(send);
    }
  }
  for (const d of dead) h.subscribers.delete(d);
  return { state, accepted: true };
}

export function subscribeLive(send: Subscriber): () => void {
  const h = hub();
  h.subscribers.add(send);
  return () => {
    h.subscribers.delete(send);
  };
}

/**
 * 本机在局域网里的地址(手机要输的那个)。跳过回环、link-local(169.254)与 IPv6。
 * 多网卡时都列出来,让用户挑能通的那个(有线 / WiFi / 热点)。
 */
export function lanHosts(): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.internal) continue;
      // Node 18+ 的 family 可能是 'IPv4' 或 4
      const isV4 = net.family === "IPv4" || (net.family as unknown as number) === 4;
      if (!isV4) continue;
      if (net.address.startsWith("169.254.")) continue;
      out.push(net.address);
    }
  }
  return out;
}
