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
