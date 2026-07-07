/**
 * 进程内的简单固定窗口限流(基础防刷)。
 * 注意:仅在单实例运行时有效;Serverless 多实例 / 冷启动会各自计数。
 * 如需更强的限流,应接入 Redis 等共享存储。
 */
type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
// 单用户内部工具;批量投递会在短时间内连发多次(逐个扫描问题/逐个投递),故默认放宽,
// 可用 RATE_LIMIT_MAX_PER_MIN 覆盖。
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_PER_MIN) || 120;
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string): { allowed: boolean } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    // 顺便清理过期 bucket,避免无限增长
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (bucket.count >= MAX_REQUESTS) {
    return { allowed: false };
  }

  bucket.count += 1;
  return { allowed: true };
}
