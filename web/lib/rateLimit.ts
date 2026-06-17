/**
 * 进程内的简单固定窗口限流(基础防刷)。
 * 注意:仅在单实例运行时有效;Serverless 多实例 / 冷启动会各自计数。
 * 如需更强的限流,应接入 Redis 等共享存储。
 */
type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
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
