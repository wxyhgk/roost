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

/**
 * 一次拖拽落下之后，该改谁的顺序。
 *
 * 这 70 行原来焊在 `app/App.tsx` 的 `DndContext` 回调里，于是**整个 App.tsx 没有测试**，
 * 而它每一种失效都是静默的：跨组插到前一位、`beforeId` 差一格、拖了个置顶会话却什么都
 * 没发生（用户看不到任何反馈）。决策本身是纯的——输入是几个列表，输出是一次调用的参数
 * ——所以它不该住在事件回调里。
 *
 * 组件那边只剩「拿到决策就照着调」。
 */
export type DropDecision =
  | { kind: "session"; sessionId: string; projectId: string | null; beforeId: string | null }
  | { kind: "project"; projectId: string; beforeId: string | null };

/**
 * 就地搬一格。**故意不引 `@dnd-kit` 的 `arrayMove`**：这个模块要能在纯 node 里测，
 * 不值得为两行代码把一个拖拽 UI 库拖进来。
 */
function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** 插入位置一律用「排在谁前面」表达，队尾是 null。`next[at + 1]` 就是这个意思。 */
const beforeOf = (list: string[], id: string) => list[list.indexOf(id) + 1] ?? null;

export function resolveDrop(input: {
  activeId: string;
  overId: string | null;
  /** 已经按 `isOpen` 过滤过的会话。这里不引 `shared/store`——那会把 React 拖进来。 */
  open: Session[];
  projectIds: string[];
  pinnedIds: string[];
}): DropDecision | null {
  const { activeId, overId, open, projectIds, pinnedIds } = input;
  if (!overId) return null;

  // 分组自身被拖动：落点仍是 project:<id>（会话的落点），按 active 的前缀改变解释。
  if (activeId.startsWith("projectdrag:")) {
    const moving = activeId.slice("projectdrag:".length);
    if (!overId.startsWith("project:")) return null;
    const target = overId.slice("project:".length);
    if (target === moving) return null;
    const from = projectIds.indexOf(moving);
    const to = projectIds.indexOf(target);
    if (from < 0 || to < 0) return null;
    return { kind: "project", projectId: moving, beforeId: beforeOf(move(projectIds, from, to), moving) };
  }

  /*
    拖的可能是画布上那张卡（id 就是 session.id），也可能是侧栏那一行
    （`sessionrow:` 前缀——两者会同时在册，id 必须错开）。落点那边没有这个问题：
    droppable 登记的一律是裸的 session.id。
  */
  const sessionId = activeId.startsWith("sessionrow:") ? activeId.slice("sessionrow:".length) : activeId;
  if (pinnedIds.includes(sessionId)) return null;

  const loose = open.filter(s => !pinnedIds.includes(s.id));
  const projectOf = (container: string) => container === "ungrouped" ? null : container.slice("project:".length);
  const containerOf = (id: string): string | null => {
    const s = loose.find(x => x.id === id);
    if (!s) return null;
    return s.projectId ? `project:${s.projectId}` : "ungrouped";
  };
  const listOf = (container: string) => loose.filter(s => containerOf(s.id) === container).map(s => s.id);

  if (overId === "ungrouped" || overId.startsWith("project:")) {
    // 落到分组空白处：挪到该组队尾。已经在队尾就什么都不做。
    const list = listOf(overId);
    if (containerOf(sessionId) === overId && list.at(-1) === sessionId) return null;
    return { kind: "session", sessionId, projectId: projectOf(overId), beforeId: null };
  }

  const toContainer = containerOf(overId);
  const fromContainer = containerOf(sessionId);
  if (!toContainer || !fromContainer) return null;
  const toList = listOf(toContainer);
  const overIndex = toList.indexOf(overId);
  if (overIndex < 0) return null;

  if (fromContainer === toContainer) {
    // 同组内排序：放到落点会话的位置。
    const oldIndex = toList.indexOf(sessionId);
    if (oldIndex < 0 || oldIndex === overIndex) return null;
    return { kind: "session", sessionId, projectId: projectOf(toContainer),
      beforeId: beforeOf(move(toList, oldIndex, overIndex), sessionId) };
  }
  // 跨组：插到落点会话前面。
  const next = [...toList.slice(0, overIndex), sessionId, ...toList.slice(overIndex)];
  return { kind: "session", sessionId, projectId: projectOf(toContainer), beforeId: beforeOf(next, sessionId) };
}
