/**
 * 完整时间戳的人话形式。
 *
 * 原来住在 `features/notes/notes.ts` 里，于是 conversations 为了显示「创建于」「最后消息」
 * 这两个字段，整个特性得去认识 notes——一条只为了三行 `toLocaleString` 而存在的特性间依赖。
 *
 * 和 `features/conversations/when.ts` 不重复：那一套（dayLabel / timeLabel / groupByDay）
 * 解决的是「同一天的记录挤在一起时怎么只显示有区别的部分」，是列表分组的语义；这里要的
 * 恰恰相反——一个孤立的时间点，年月日时分秒都得写全。
 */
export function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}
