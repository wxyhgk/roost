import { CommandLineIcon } from "@heroicons/react/24/outline";
import { useWorkspace } from "../../shared/store";
import { NoticeBar } from "../../shared/ui/NoticeBar";
import { WorkspaceRows } from "./WorkspaceRows";
import { SidebarRoot } from "../../vendor/dsh/sidebar/SidebarRoot";
import type { Scope } from "../../shared/view";
import { t } from "@roost/i18n";

/**
 * 终端模式的左栏：一列工作区，每个能展开出它的终端。
 *
 * **外壳和行现在和对话模式是同一套**（`vendor/dsh/sidebar/`）：品牌行 + 新建按钮 +
 * 面板行 + 浏览区 + 底部座位，折叠态是 **56px 图标轨、不是整块不画**。
 *
 * 在此之前这里是我们自己的 Tailwind 盒子：29px 的 `PanelHeader`（字还加粗）、48px 的卡片行、
 * 底部一条虚线按钮，而对话模式那边是 60px 的品牌行加 32px 的上游行。同一个应用的两个模式，
 * 左栏的头差了一倍高——这正是「前端 UI 割裂」的来源。搬来的那套侧栏**本来就是为
 * 「工作区 + 会话」设计的**，我们此前只把它用在了一半应用上。
 *
 * 五个座位分别喂了什么：
 *
 * | 座位 | 终端模式 | 对话模式 |
 * | --- | --- | --- |
 * | 品牌行 | `Roost`，点它 = 新建终端 | `Roost`，点它 = 新建对话 |
 * | 新建按钮 | 新建终端（落在你正在看的工作区，和快速新建菜单同一处） | 新建对话 |
 * | 面板行 | 「全部终端」——不筛的那个视角 | 没有 |
 * | 浏览区 | 工作区树（`WorkspaceRows`） | 对话目录（`ConversationRows`） |
 * | 底部 | 空 | 空 |
 *
 * 「全部终端」用**面板行**这个座位，是因为它本来就不是列表里的一条：它是一个全局视角，
 * 钉在列表之上、不展开（画布本来就在显示全部，侧栏再列一遍是同一份内容讲两遍）。
 * 上游那一格装的正是这种东西。
 */
export function Sidebar({ collapsed, width, onToggle, scope, onScope, onEnterTerminal }: {
  /** 折叠成 56px 轨。由 Shell 的布局状态给。 */
  collapsed: boolean;
  /** 展开态的列宽。折叠动画期间内容冻在这个宽度上淡出。 */
  width: number;
  onToggle: () => void;
  scope: Scope;
  onScope: (scope: Scope) => void;
  /** 从侧栏点开一个终端时切到终端视图，别停在画布上。 */
  onEnterTerminal: () => void;
}) {
  const { error, addSession, selectSession } = useWorkspace("error", "addSession", "selectSession");

  return (
    <SidebarRoot
      collapsed={collapsed}
      width={width}
      onToggle={onToggle}
      /*
        新建终端落在**你正在看的工作区**，和顶栏快速新建菜单里那一项是同一个表达式——
        两个入口同一个动作，结果不能不一样。不顺带切进终端视图：新开的终端会以一张卡片
        出现在画布上，而画布正是你此刻在看的东西。
      */
      onNewSession={() => addSession(scope === "all" ? null : scope)}
      /* 品牌位放产品名，不是「工作区」——区段头已经写着「工作区」了，重一遍是噪音。 */
      brandName="Roost"
      labels={{
        newSession: t.sidebar.newTerminal,
        newSessionLabel: t.sidebar.newTerminal,
        toggleOpen: t.sidebar.toggleOpen,
        toggleCollapse: t.sidebar.toggleCollapse,
        panels: t.sidebar.panels,
      }}
      panels={[{
        id: "all",
        label: t.sidebar.allTerminals,
        active: scope === "all",
        icon: ({ size }) => <CommandLineIcon style={{ width: size, height: size }} />,
      }]}
      onSelectPanel={() => onScope("all")}
      region={owner => (
        <>
          {/* 出错横幅只在宽的时候画：56px 轨上一句话放不下，而它不是能缩成图标的东西。 */}
          {owner.wide && error && <NoticeBar tone="error">{error}</NoticeBar>}
          <WorkspaceRows
            wide={owner.wide}
            scope={scope}
            onScope={onScope}
            onExpandSidebar={owner.expandSidebar}
            onOpenSession={id => {
              selectSession(id);
              onEnterTerminal();
            }}
          />
        </>
      )}
    />
  );
}
