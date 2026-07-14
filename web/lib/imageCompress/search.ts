// 图片压缩的「找最优设置」算法(纯逻辑,不碰 DOM,方便单测)。
// 策略:优先保住分辨率——从大到小依次尝试各缩放档;在某一档里,若最低画质都还
// 超标就换更小的档,否则在该档内二分找「不超标的最高画质」并返回(保留最大分辨率)。

export const MB = 1024 * 1024;

/** 解析用户输入的目标大小(MB),非正数/非数字返回 null。 */
export function parseTargetMb(input: string): number | null {
  const v = Number(String(input).trim());
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** 人类可读的体积。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/** 按 (缩放档, 画质) 编码一次,返回结果体积与实际像素尺寸。 */
export type EncodeFn = (
  scale: number,
  quality: number,
) => Promise<{ size: number; blob: Blob; width: number; height: number }>;

export interface SearchResult {
  blob: Blob;
  quality: number;
  scale: number;
  size: number;
  width: number;
  height: number;
  hitTarget: boolean; // 是否达到「≤ 目标」
}

export interface SearchOpts {
  targetBytes: number;
  encode: EncodeFn;
  scales?: number[]; // 缩放档,降序;默认 [1, .85, .7, .55, .4, .3, .2]
  qualitySteps?: number; // 每档二分次数,默认 7
  minQuality?: number; // 默认 0.05
  maxQuality?: number; // 默认 0.95
  onProgress?: (info: { scale: number; attempts: number }) => void;
}

export const DEFAULT_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];

export async function searchBestSetting(opts: SearchOpts): Promise<SearchResult> {
  const scales = opts.scales ?? DEFAULT_SCALES;
  const steps = opts.qualitySteps ?? 7;
  const minQ = opts.minQuality ?? 0.05;
  const maxQ = opts.maxQuality ?? 0.95;
  const { targetBytes, encode, onProgress } = opts;

  let smallest: SearchResult | null = null; // 全程最小的结果(达不到目标时的兜底)
  let attempts = 0;

  const mkResult = (
    r: { size: number; blob: Blob; width: number; height: number },
    quality: number,
    scale: number,
  ): SearchResult => ({ ...r, quality, scale, hitTarget: r.size <= targetBytes });

  for (const scale of scales) {
    // 这一档的最低画质是否已达标?没达标就换更小的档。
    const low = mkResult(await encode(scale, minQ), minQ, scale);
    attempts++;
    onProgress?.({ scale, attempts });
    if (!smallest || low.size < smallest.size) smallest = low;
    if (!low.hitTarget) continue;

    // 最低画质已达标 → 在本档二分「不超标的最高画质」。
    let lo = minQ;
    let hi = maxQ;
    let best = low;
    for (let i = 0; i < steps; i++) {
      const q = (lo + hi) / 2;
      const res = mkResult(await encode(scale, q), q, scale);
      attempts++;
      onProgress?.({ scale, attempts });
      if (res.size < smallest.size) smallest = res;
      if (res.hitTarget) {
        if (res.quality >= best.quality) best = res;
        lo = q; // 还能更清晰
      } else {
        hi = q;
      }
    }
    return best;
  }

  // 所有档最低画质都超标 → 返回见过的最小结果(hitTarget=false,由 UI 提示尽力值)。
  // scales 非空,循环至少跑一次,smallest 必被赋值。
  if (!smallest) throw new Error("searchBestSetting: scales 为空");
  return smallest;
}
