/**
 * 本地 rednote 服务（默认 127.0.0.1:3456）的薄封装。
 * 收敛「上传图片拿 file_id」「把标签名解析成真话题」「取自己的 user_id」这几个动作 ——
 * 签名与登录态全在那个服务里，浏览器不接触。
 *
 * 注意：rednote 服务是全局串行的（server.py 每个请求外面套了一把锁），
 * 所以上传 N 张只能一张一张来，不要并发打过去。
 */

import type { HashTag } from "./topics";

export const REDNOTE_BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

const UPLOAD_TIMEOUT_MS = 60_000;
/** 话题解析是「一个标签一次签名搜索」串行跑的，5~10 个标签要留够时间 */
const TOPICS_TIMEOUT_MS = 60_000;
const ME_TIMEOUT_MS = 20_000;

/** 连不上本地服务时抛出，路由层映射为 502 并提示「请确认 rednote 在运行」。 */
export class RednoteUnreachableError extends Error {
  constructor() {
    super(`无法连接本地 rednote 服务(${REDNOTE_BASE})`);
    this.name = "RednoteUnreachableError";
  }
}

/** 上游明确返回失败时抛出，带上它给的原因（如账号风控）。 */
export class RednoteFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RednoteFailedError";
  }
}

/**
 * 上传一张图片，返回可直接放进发布 body 的 file_id。
 * rednote 的 /creator/upload 一次只能传一张（内部 file_count 写死 1），要 N 张就调 N 次。
 */
export async function uploadImage(
  bytes: Buffer,
  contentType = "image/png",
): Promise<string> {
  const url = new URL("/rednote/creator/upload", REDNOTE_BASE);
  url.searchParams.set("content_type", contentType);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let json: { ok?: boolean; file_id?: string; error?: string } | null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });
    json = (await res.json().catch(() => null)) as typeof json;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new RednoteFailedError("图片上传超时，请重试。");
    }
    throw new RednoteUnreachableError();
  } finally {
    clearTimeout(timer);
  }

  if (!json?.ok || !json.file_id) {
    throw new RednoteFailedError(json?.error ? `图片上传失败：${json.error}` : "图片上传失败。");
  }
  return json.file_id;
}

/** GET 一个只读端点并解析 JSON；连不上抛 RednoteUnreachableError，超时抛 RednoteFailedError。 */
async function getJson<T>(path: string, params: Record<string, string>, timeoutMs: number, what: string) {
  const url = new URL(path, REDNOTE_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return (await res.json().catch(() => null)) as T | null;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new RednoteFailedError(`${what}超时，请重试。`);
    }
    throw new RednoteUnreachableError();
  } finally {
    clearTimeout(timer);
  }
}

export type ResolvedTopics = {
  /** 匹配到的真话题，顺序与传入的名字一致；可直接放进 hash_tag */
  tags: HashTag[];
  /** 小红书上没有同名话题的名字（不会写进 desc —— 假话题没有意义） */
  missing: string[];
};

/**
 * 把标签名解析成真话题（`{id, name, link}`）。走 rednote 的 `/creator/topics?resolve=`，
 * 它对每个名字做一次话题搜索并取**精确同名**项（忽略大小写）。
 *
 * ⚠️ 该端点在有 missing 时会回 `ok:false`（它的 ok 表示「全都解析到了」），
 * 所以这里**不能**拿 ok 判断成败 —— 只看有没有 tags 数组。
 */
export async function resolveTopics(names: readonly string[]): Promise<ResolvedTopics> {
  // resolve 的线格式是逗号分隔，名字里带逗号会被切碎 —— 这类名字直接判为未匹配，别发出错话题。
  const query = names.filter((n) => !n.includes(","));
  const unsupported = names.filter((n) => n.includes(","));
  if (query.length === 0) return { tags: [], missing: [...unsupported] };

  const json = await getJson<{ tags?: unknown; missing?: unknown; error?: unknown }>(
    "/rednote/creator/topics",
    { resolve: query.join(",") },
    TOPICS_TIMEOUT_MS,
    "话题解析",
  );
  if (!json || !Array.isArray(json.tags)) {
    const detail = typeof json?.error === "string" ? json.error : "";
    throw new RednoteFailedError(detail ? `话题解析失败：${detail}` : "话题解析失败。");
  }

  const tags = (json.tags as HashTag[]).filter((t) => t && t.id && t.name);
  const missing = Array.isArray(json.missing)
    ? (json.missing as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  return { tags, missing: [...missing, ...unsupported] };
}

/**
 * 当前登录账号的 user_id —— 「声明原创」的 bizId 就是它
 * （见 creator_publish_options.md §1：原创没有独立接口，纯粹是发布 body 里的一条 bind）。
 */
export async function fetchSelfUserId(): Promise<string> {
  const json = await getJson<{ ok?: boolean; user_id?: unknown; error?: unknown }>(
    "/rednote/creator/me",
    {},
    ME_TIMEOUT_MS,
    "获取账号信息",
  );
  const uid = typeof json?.user_id === "string" ? json.user_id.trim() : "";
  if (!uid) {
    const detail = typeof json?.error === "string" ? json.error : "";
    throw new RednoteFailedError(
      detail ? `取不到当前账号 user_id：${detail}` : "取不到当前账号 user_id（浏览器可能未登录）。",
    );
  }
  return uid;
}
