/**
 * 计算「目标周」的默认值:相对某个基准日期的本周工作日 Mon–Fri。
 * 周末(周六/周日)则取下周一起的那一周。返回像 "July 6–10, 2026" 的可读区间,
 * 供前端预填一个可编辑的「目标周」输入框(用户可随时改)。
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 该周的周一(周末则顺延到下周一) */
function mondayOf(d: Date): Date {
  const day = d.getDay(); // 0=Sun..6=Sat
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day === 0) copy.setDate(copy.getDate() + 1); // Sun -> next Mon
  else if (day === 6) copy.setDate(copy.getDate() + 2); // Sat -> next Mon
  else copy.setDate(copy.getDate() - (day - 1)); // Mon..Fri -> this Mon
  return copy;
}

/** 把 Mon–Fri 格式化为可读区间,跨月/跨年时补全月份与年份 */
export function formatWeekRange(monday: Date): string {
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);

  const mMon = MONTHS[monday.getMonth()];
  const mFri = MONTHS[friday.getMonth()];
  const y = friday.getFullYear();

  if (monday.getMonth() === friday.getMonth()) {
    return `${mMon} ${monday.getDate()}–${friday.getDate()}, ${y}`;
  }
  if (monday.getFullYear() === friday.getFullYear()) {
    return `${mMon} ${monday.getDate()} – ${mFri} ${friday.getDate()}, ${y}`;
  }
  return `${mMon} ${monday.getDate()}, ${monday.getFullYear()} – ${mFri} ${friday.getDate()}, ${y}`;
}

/** 相对基准日(默认今天)的默认目标周区间字符串 */
export function defaultTargetWeek(base: Date = new Date()): string {
  return formatWeekRange(mondayOf(base));
}

/** 月份名(全称 + 三字母缩写)→ 0-11 索引 */
const MONTH_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  MONTHS.forEach((name, i) => {
    m[name.toLowerCase()] = i;
    m[name.slice(0, 3).toLowerCase()] = i;
  });
  return m;
})();

// 匹配「月 日 – [月] 日 [, 年]」这类工作周区间,如 "June 29–July 3"、"July 6–10, 2026"。
// 必须以月份单词开头,所以 "3–5" / "top 3–5 improvements" 这类不含月份的范围不会误匹配。
const RANGE_RE =
  /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[–—-]\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2})(?:,?\s*(\d{4}))?/g;

/**
 * 从上一封工作邮件文本里识别它覆盖的那一周(取文本中最晚的一个「月 日–日」区间),
 * 再返回**下一**个连续工作周 Mon–Fri 的可读区间(如 "July 6–10, 2026")。
 * 识别不到日期则返回 null(前端回退到相对今天的默认值)。
 * 年份优先用区间自带的,其次用文本里出现的 20xx,再次用 fallbackYear。纯函数,可测。
 */
export function detectNextWeekFromText(text: string, fallbackYear?: number): string | null {
  if (!text) return null;
  const yearInText = text.match(/\b(20\d{2})\b/);
  const baseYear = yearInText ? Number(yearInText[1]) : fallbackYear;

  let bestStart: Date | null = null;
  for (const m of text.matchAll(RANGE_RE)) {
    const monthIdx = MONTH_INDEX[m[1].toLowerCase()];
    if (monthIdx === undefined) continue;
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    const year = m[5] ? Number(m[5]) : baseYear;
    if (!year) continue;
    const start = new Date(year, monthIdx, day);
    if (Number.isNaN(start.getTime())) continue;
    if (!bestStart || start.getTime() > bestStart.getTime()) bestStart = start;
  }
  if (!bestStart) return null;

  // 归一到那一周的周一,再 +7 天得到下一周的周一
  const nextMonday = mondayOf(bestStart);
  nextMonday.setDate(nextMonday.getDate() + 7);
  return formatWeekRange(nextMonday);
}
