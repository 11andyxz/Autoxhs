/**
 * 本地 rednote 服务（默认 127.0.0.1:3456）的薄封装。
 * 只收敛「上传图片拿 file_id」这一个动作 —— 签名与登录态全在那个服务里，浏览器不接触。
 *
 * 注意：rednote 服务是全局串行的（server.py 每个请求外面套了一把锁），
 * 所以上传 N 张只能一张一张来，不要并发打过去。
 */

export const REDNOTE_BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

const UPLOAD_TIMEOUT_MS = 60_000;

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
