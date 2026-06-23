import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = process.env.REDNOTE_API_BASE || "http://127.0.0.1:3456";

type PublishRequest = {
  title?: string;
  body?: string;
  tags?: string[];
  images?: unknown;
  confirm?: boolean;
};

type PublishImage = {
  url: string;
  width: number;
  height: number;
};

type RednotePublishResponse = {
  ok?: boolean;
  dry_run?: boolean;
  published?: boolean;
  error?: unknown;
  message?: unknown;
  msg?: unknown;
  detail?: unknown;
  code?: string | number;
  response?: unknown;
};

function getFailureDetail(result: RednotePublishResponse) {
  for (const value of [result.error, result.message, result.msg, result.detail, result.response]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (
      value &&
      typeof value === "object" &&
      "message" in value &&
      typeof value.message === "string" &&
      value.message.trim()
    ) {
      return value.message.trim();
    }
  }
  return null;
}

function getFailureCode(result: RednotePublishResponse) {
  if (result.code !== undefined) return result.code;
  if (result.response && typeof result.response === "object" && "code" in result.response) {
    const code = result.response.code;
    if (typeof code === "string" || typeof code === "number") return code;
  }
  return undefined;
}

function parseImportedImages(value: unknown): PublishImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!image || typeof image !== "object" || !("url" in image) || typeof image.url !== "string") {
      return [];
    }
    try {
      const url = new URL(image.url);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.endsWith(".xhscdn.com")) return [];
      const width = "width" in image && typeof image.width === "number" ? image.width : 1080;
      const height = "height" in image && typeof image.height === "number" ? image.height : 1440;
      if (width <= 0 || height <= 0) return [];
      return [{ url: image.url, width, height }];
    } catch {
      return [];
    }
  });
}

async function uploadImages(images: PublishImage[]) {
  const uploaded: Array<{ file_id: string; width: number; height: number }> = [];
  for (const [index, image] of images.entries()) {
    const target = new URL("/rednote/creator/upload", BASE);
    target.searchParams.set("url", image.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(target, { method: "POST", signal: controller.signal });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; file_id?: unknown; error?: unknown }
        | null;
      if (!result?.ok || typeof result.file_id !== "string" || !result.file_id) {
        const detail = typeof result?.error === "string" ? `：${result.error}` : "";
        throw new Error(`第 ${index + 1} 张图片上传失败${detail}`);
      }
      uploaded.push({ file_id: result.file_id, width: image.width, height: image.height });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new Error(`第 ${index + 1} 张图片上传超时`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return uploaded;
}

/**
 * 将页面中的标题、正文和标签转发给本地 rednote 发布服务。
 * 不透传 dry-run 返回的 request 字段，避免把签名或登录态信息暴露给浏览器。
 */
export async function POST(req: NextRequest) {
  let request: PublishRequest;
  try {
    request = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const title = (request.title ?? "").trim();
  const body = (request.body ?? "").trim();
  const tags = (Array.isArray(request.tags) ? request.tags : [])
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!title || !body) {
    return NextResponse.json({ success: false, error: "请先生成并保留标题和正文。" }, { status: 400 });
  }
  const confirm = request.confirm === true;
  const images = parseImportedImages(request.images);
  if (confirm && !images.length) {
    return NextResponse.json(
      {
        success: false,
        error: "真实发布至少需要一张图片。请先通过“从链接导入”加载带图片的笔记。",
      },
      { status: 400 },
    );
  }

  let uploadedImages: Array<{ file_id: string; width: number; height: number }> = [];
  if (confirm) {
    try {
      uploadedImages = await uploadImages(images);
    } catch (error) {
      return NextResponse.json(
        { success: false, error: (error as Error)?.message ?? "图片上传失败。" },
        { status: 502 },
      );
    }
  }

  const publishBody = {
    common: {
      type: "normal",
      note_id: "",
      source: JSON.stringify({ type: "web", ids: "", extraInfo: JSON.stringify({ systemId: "web" }) }),
      title,
      desc: [...[body], ...tags].join("\n\n"),
      ats: [],
      hash_tag: [],
      privacy_info: { op_type: 1, type: 1, user_ids: [] },
    },
    image_info: { images: uploadedImages },
    video_info: null,
  };
  const endpoint = `${BASE}/rednote/creator/publish${confirm ? "?confirm=1" : ""}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(publishBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await response.text();
    let result: RednotePublishResponse | null = null;
    try {
      result = JSON.parse(raw) as RednotePublishResponse;
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: `发布服务返回非 JSON 响应（HTTP ${response.status}）。`,
        },
        { status: 502 },
      );
    }
    if (!result?.ok) {
      const detail = getFailureDetail(result ?? {});
      const upstreamCode = getFailureCode(result ?? {});
      const code = upstreamCode === undefined ? "" : `（code ${upstreamCode}）`;
      return NextResponse.json(
        {
          success: false,
          error: detail
            ? `发布服务错误${code}：${detail}`
            : `发布服务未返回具体错误${code}（HTTP ${response.status}）。`,
        },
        { status: 502 },
      );
    }
    if (confirm && !result.published) {
      return NextResponse.json(
        { success: false, error: "发布服务未确认发布成功。" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      dryRun: !confirm,
      published: confirm,
    });
  } catch (err) {
    const isAbort = (err as Error)?.name === "AbortError";
    return NextResponse.json(
      {
        success: false,
        error: isAbort
          ? "发布请求超时，请重试。"
          : `无法连接本地 rednote 服务(${BASE})，请确认它在运行且浏览器已登录。`,
      },
      { status: 502 },
    );
  }
}
