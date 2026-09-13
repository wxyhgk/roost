import type { Session } from "../../shared/types";
import type { Scope } from "../../shared/view";

/**
 * 画布上要显示哪些终端，按什么顺序。
 *
 * 挑出属于当前工作区的，置顶的排在前面（顺序按你置顶的先后），其余保持原有顺序。
 *
 * **用分区拼接而不是一个 sort 比较器。** 拿 `Infinity` 当「没置顶」的排序键的话，
 * 两个都没置顶时 `Infinity - Infinity` 是 `NaN`，而比较器返回 NaN 在规范里是未定义
 * 行为。V8 目前恰好容忍（TimSort 会保持原序），所以那样写在 Chrome 和 Node 上看不出
 * 问题——但那是实现细节，不是承诺。分区拼接不依赖任何比较器行为。
 */
export function scopedSessions(sessions: Session[], scope: Scope, pinnedIds: string[]): Session[] {
  const rank = new Map(pinnedIds.map((id, index) => [id, index]));
  const inScope = sessions.filter(s => scope === "all" || s.projectId === (scope === null ? null : scope));
  return [
    ...inScope.filter(s => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
    ...inScope.filter(s => !rank.has(s.id)),
  ];
}
