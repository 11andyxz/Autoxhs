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
type Owner = { id: string; startedAt: number; lastAt: number };

/** 当前发布者静默这么久就让位(页面被关掉 / 断网了) */
const OWNER_STALE_MS = 8_000;

type Hub = {
  state: LiveState;
  subscribers: Set<Subscriber>;
  /** 配对码:副屏地址里的 k=,一个进程内固定不变(手机可以存书签) */
  code: string;
  owner: Owner | null;
};

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
    };
  }
  return globalForHub.__autoxhsLiveHub;
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

  if (!owner || owner.id === publisher.id) {
    h.owner = { id: publisher.id, startedAt: publisher.startedAt, lastAt: now };
  } else if (publisher.startedAt > owner.startedAt || now - owner.lastAt > OWNER_STALE_MS) {
    // 更晚打开的页面接管;或者原主人已经没声了(标签页被关了)。
    h.owner = { id: publisher.id, startedAt: publisher.startedAt, lastAt: now };
  } else {
    return { state: h.state, accepted: false };
  }

  const state: LiveState = { ...partial, v: h.state.v + 1, at: now };
  h.state = state;
  for (const send of h.subscribers) {
    try {
      send(state);
    } catch {
      /* 单个副屏写失败不影响别人;它自己的 SSE 会清理 */
    }
  }
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
