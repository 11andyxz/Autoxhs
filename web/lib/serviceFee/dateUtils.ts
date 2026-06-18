/**
 * 所有日期都用「UTC 午夜时间戳」表示,彻底避开本地时区漂移。
 * 输入字符串统一为 'YYYY-MM-DD'。
 */
export const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 'YYYY-MM-DD' -> UTC 午夜时间戳 */
export function parseDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 时间戳 -> 'YYYY-MM-DD' */
export function toISO(ts: number): string {
  const dt = new Date(ts);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 时间戳 -> 'MM/DD/YYYY' */
export function formatUS(ts: number): string {
  const dt = new Date(ts);
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const y = dt.getUTCFullYear();
  return `${m}/${d}/${y}`;
}

export function addDays(ts: number, n: number): number {
  return ts + n * DAY_MS;
}

/** 含两端的天数差(b - a) */
export function diffDays(a: number, b: number): number {
  return Math.round((b - a) / DAY_MS);
}

/** 0=Sun ... 6=Sat */
export function dayOfWeek(ts: number): number {
  return new Date(ts).getUTCDay();
}

export function isWeekday(ts: number): boolean {
  const d = dayOfWeek(ts);
  return d >= 1 && d <= 5;
}

/** 该日期所在「周一–周日」自然周的周一(UTC 午夜) */
export function mondayOf(ts: number): number {
  const dow = dayOfWeek(ts); // 0=Sun..6=Sat
  const back = (dow + 6) % 7; // 距离本周一的天数(周一=0)
  return addDays(ts, -back);
}

/** 'YYYY-MM' 月份键 */
export function monthKey(ts: number): string {
  const dt = new Date(ts);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 'June 2026' 月份标签 */
export function monthLabel(ts: number): string {
  const dt = new Date(ts);
  return `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** 该时间戳所在月的天数 */
export function daysInMonthOf(ts: number): number {
  const dt = new Date(ts);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
}

/** 该时间戳所在月的最后一天(UTC 午夜) */
export function lastOfMonth(ts: number): number {
  const dt = new Date(ts);
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0);
}

/** 'YYYY-MM' -> 该月天数 */
export function daysInMonthKey(mk: string): number {
  const [y, m] = mk.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
