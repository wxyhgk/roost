import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { resolveDrop } from "../features/terminal/sessionOrder";
import { NewBuildNotice } from "./NewBuildNotice";
import { useEffect, useState } from "react";
import { SessionLogo } from "../shared/ui/SessionLogo";
import { Shell } from "./Shell";
import { useLocale } from "../shared/locale";
import { isOpen, useWorkspace } from "../shared/store";
import type { CliKind } from "../shared/types";
import { useAgentNotify } from "../features/session-status/public";

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
    /*
      决策全在 `resolveDrop` 里，纯函数、有测试（tests/session-order.test.ts）。
      这里只负责把它的结果照着调一遍——原来那 70 行长在这个回调里，于是整个 App.tsx
      没有测试，而它每一种失效都是静默的。
    */
    const decision = resolveDrop({
      activeId: String(event.active.id),
      overId: event.over ? String(event.over.id) : null,
      open: allSessions.filter(isOpen),
      projectIds: projects.map(p => p.id),
      pinnedIds: pinnedSessionIds,
    });
    if (!decision) return;
    if (decision.kind === "project") reorderProject(decision.projectId, decision.beforeId);
    else reorderSession(decision.sessionId, decision.projectId, decision.beforeId);
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
      <NewBuildNotice />
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
