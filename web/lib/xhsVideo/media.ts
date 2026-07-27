/**
 * 笔记图片下载:把小红书 CDN 图片(webp)下载并转成 data URL,供无头 Chrome 在幻灯片里内联显示
 * (内联而非用远程 URL,避免无头环境下的网络/时序问题,与 OCR 的做法一致)。
 */

/** 下载单张图片转 data URL;失败返回 null(不阻断整段流程)。 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/webp";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 并行下载多张图片,保留原始顺序;失败的位置为 null。 */
export async function downloadImagesAsDataUrls(urls: string[]): Promise<Array<string | null>> {
  return Promise.all(urls.map((u) => fetchAsDataUrl(u)));
}
