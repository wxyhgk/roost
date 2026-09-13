import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useEffect, useState } from "react";
import { SessionLogo } from "../shared/ui/SessionLogo";
import { Shell } from "./Shell";
import { useLocale } from "../shared/locale";
import { isOpen, useWorkspace } from "../shared/store";
import type { CliKind } from "../shared/types";
import { useAgentNotify } from "../features/session-status/quietNotify";

/**
 * 鼠标和触屏必须分开，因为「按住不动然后移动」在两种输入上的含义完全相反。
 *
 * 鼠标：移动 8px 即开始拖拽——桌面上没有别的手势会和它冲突，保持原行为。
 *
 * 触屏：**必须改成长按**。原先只挂一个 PointerSensor（距离 8px 激活）、且每行都写着
 * `touch-none`，两者叠加的后果是手机上滑不动会话列表，而且一想滚动就把会话拖乱序——
 * 手指纵向滑动位移必然超过 8px，于是每次滚动都被判成拖拽。改成长按之后，快速滑动
 * 交给浏览器滚动，按住不放才进入排序。
 *
 * delay/tolerance 是起始值，真机上手感不对就调；tolerance 表示按住期间允许的
 * 抖动量，太小会让手指的自然微动取消掉长按。
 */
const mouseOptions = { activationConstraint: { distance: 8 } };
const touchOptions = { activationConstraint: { delay: 250, tolerance: 8 } };

type DragInfo = { kind: "session"; title: string; cli?: CliKind | null; cliId?: string | null }
  | { kind: "project"; title: string };
export function App() {
  const { sessions: allSessions, reorderSession, pinnedSessionIds, projects, reorderProject } =
    useWorkspace("sessions", "reorderSession", "pinnedSessionIds", "projects", "reorderProject");
  const [drag, setDrag] = useState<DragInfo | null>(null);
  useAgentNotify();
  const locale = useLocale(); // 语言切换时重渲染整棵树；memo 组件各自订阅。
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const sensors = useSensors(useSensor(MouseSensor, mouseOptions), useSensor(TouchSensor, touchOptions));

  const onDragEnd = (event: DragEndEvent) => {
    setDrag(null);
    const { active, over } = event;
    if (!over) return;

    // 分组自身被拖动：落点仍是 project:<id>（会话的落点），按 active 的前缀改变解释。
    const activeId = String(active.id);
    if (activeId.startsWith("projectdrag:")) {
      const moving = activeId.slice("projectdrag:".length);
      const overId = String(over.id);
      if (!overId.startsWith("project:")) return;
      const target = overId.slice("project:".length);
      if (target === moving) return;
      const ids = projects.map((p) => p.id);
      const from = ids.indexOf(moving);
      const to = ids.indexOf(target);
      if (from < 0 || to < 0) return;
      const next = arrayMove(ids, from, to);
      const at = next.indexOf(moving);
      reorderProject(moving, next[at + 1] ?? null);
      return;
    }

    const sessionId = activeId;
    if (pinnedSessionIds.includes(sessionId)) return;
    const overId = String(over.id);
    const open = allSessions.filter(isOpen).filter((s) => !pinnedSessionIds.includes(s.id));
    const projectOf = (container: string) =>
      container === "ungrouped" ? null : container.slice("project:".length);
    const findContainer = (id: string): string | null => {
      const s = open.find((x) => x.id === id);
      if (!s) return null;
      return s.projectId ? `project:${s.projectId}` : "ungrouped";
    };
    const listOf = (container: string) =>
      open.filter((s) => findContainer(s.id) === container).map((s) => s.id);

    if (overId === "ungrouped" || overId.startsWith("project:")) {
      // 落到分组空白处：挪到该组队尾
      const from = findContainer(sessionId);
      const list = listOf(overId);
      if (from === overId && list[list.length - 1] === sessionId) return;
      reorderSession(sessionId, projectOf(overId), null);
      return;
    }
    const toContainer = findContainer(overId);
    const fromContainer = findContainer(sessionId);
    if (!toContainer || !fromContainer) return;
    const toList = listOf(toContainer);
    const overIndex = toList.indexOf(overId);
    if (overIndex < 0) return;
    if (fromContainer === toContainer) {
      // 同组内排序：放到落点会话的位置
      const oldIndex = toList.indexOf(sessionId);
      if (oldIndex < 0 || oldIndex === overIndex) return;
      const next = arrayMove(toList, oldIndex, overIndex);
      const at = next.indexOf(sessionId);
      reorderSession(sessionId, projectOf(toContainer), next[at + 1] ?? null);
      return;
    }
    // 跨组：插到落点会话前面
    const next = [...toList.slice(0, overIndex), sessionId, ...toList.slice(overIndex)];
    const at = next.indexOf(sessionId);
    reorderSession(sessionId, projectOf(toContainer), next[at + 1] ?? null);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => {
        const id = String(e.active.id);
        const data = e.active.data.current as { title?: string; cli?: CliKind | null; cliId?: string | null; projectName?: string } | undefined;
        setDrag(id.startsWith("projectdrag:")
          ? { kind: "project", title: data?.projectName ?? "Project" }
          : { kind: "session", title: data?.title ?? "Session", cli: data?.cli, cliId: data?.cliId });
      }}
      onDragCancel={() => setDrag(null)}
      onDragEnd={onDragEnd}
    >
      <Shell />
      <DragOverlay dropAnimation={null}>
        {drag ? (
          <div className="flex w-60 items-center gap-2.5 rounded-lg border border-text-dim bg-bg-raised px-2.5 py-2 shadow-pop opacity-100 cursor-grabbing">
            {drag.kind === "session" && (
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-text/8 text-text-dim">
                <SessionLogo cli={drag.cli} cliId={drag.cliId} />
              </span>
            )}
            <span className={`min-w-0 flex-1 truncate ${drag.kind === "project" ? "font-semibold" : "font-medium"}`} title={drag.title}>{drag.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
