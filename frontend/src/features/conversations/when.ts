import { t } from "@roost/i18n";

/**
 * 对话列表里的时间显示。
 *
 * 目录里全是同一天的记录时，`2026/9/9 21:36:16` 这种全长格式有一多半字符对每一行
 * 都完全相同——而时间恰恰是这些行**唯一**的区分线索（真实数据里 17 条有 10 条
 * 标题都叫「前端」）。所以只显示真正有区别的那部分，并按天分组把日期提到组标题上。
 */

const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** 分组键：同一天的归一组。用当天零点的时间戳，排序天然正确。 */
export const dayKey = (time: number) => startOfDay(time);

export function dayLabel(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days <= 0) return t.misc.conversations.today;
  if (days === 1) return t.misc.conversations.yesterday;
  return t.misc.conversations.olderGroup(
    new Date(time).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }));
}

/** 组内只显示时刻——日期已经在组标题上了，再写一遍是重复。 */
export const timeLabel = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** 把已按时间倒序的条目切成按天分组的段落。 */
export function groupByDay<T>(items: T[], timeOf: (item: T) => number): { key: number; label: string; items: T[] }[] {
  const groups: { key: number; label: string; items: T[] }[] = [];
  for (const item of items) {
    const key = dayKey(timeOf(item));
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(timeOf(item)), items: [item] });
  }
  return groups;
}
