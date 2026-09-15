import { ConversationRows } from "./ConversationRows";
import { FollowTerminal } from "./FollowTerminal";
import { SidebarRoot } from "../../vendor/dsh/sidebar/SidebarRoot";
import { useWorkspace } from "../../shared/store";
import { t } from "@roost/i18n";

/**
 * 左栏的对话目录。
 *
 * 外壳和行都是搬来的（`vendor/dsh/sidebar/`）：品牌行 + 新建按钮 + 浏览区 + 底部设置，
 * 折叠态是 **56px 图标轨、不是宽度 0**。
 *
 * 和目录浮层（`ConversationList`）的区别只有一条：**点一行不让列表让位**，而是让中栏切到
 * 那条对话。左栏的用处是「一列扫下来找回刚才那条」，找的过程中列表消失是反的。
 *
 * 点一行会**关掉「跟随当前终端」**。开着跟随时，`FollowTerminal` 会在终端身份变化时把
 * 选择改回终端正在跑的那条——你刚点开的历史会被它顶掉，看起来像点了没反应。想回到跟随，
 * 勾那个框就行。
 *
 * 点一行还会把中栏从画布切进终端视图（`onEnterTerminal`）。**一个终端都没打开时中栏会被
 * 强制留在画布**（`TerminalPane` 那条兜底），这时点一行只会选中它，中栏不动：对话此刻
 * 没有可以挂靠的终端。
 */
export function ConversationSidebar({ collapsed, width, onToggle, onEnterTerminal }: {
  /** 折叠成 56px 轨。由 Shell 的布局状态给。 */
  collapsed: boolean;
  /** 展开态的列宽。折叠动画期间内容冻在这个宽度上淡出。 */
  width: number;
  onToggle: () => void;
  onEnterTerminal: () => void;
}) {
  const { selectConversation, selectedConversationId, setFollowTerminalConversation } =
    useWorkspace("selectConversation", "selectedConversationId", "setFollowTerminalConversation");
  return (
    <SidebarRoot
      collapsed={collapsed}
      width={width}
      onToggle={onToggle}
      /*
        **「新建对话」现在还做不了事。** 从零建一条对话需要 `native_session_id`，而那个 ID
        只有 CLI 在 PTY 里跑起来之后才存在（`conversation_sources` 里它是 NOT NULL）——
        终端在这个系统里不只是当前的接线方式，它是对话身份的生产者。所以这颗钮暂时等同于
        「去终端画布开一个」，而不是画一颗点了没反应的按钮。
      */
      onNewSession={onEnterTerminal}
      /* 品牌位放产品名，不是「对话」——区段头已经写着「对话」了，重一遍是噪音。 */
      brandName="Roost"
      labels={{
        newSession: t.misc.conversations.sidebar.newConversation,
        newSessionLabel: t.misc.conversations.sidebar.newConversationLabel,
        toggleOpen: t.misc.conversations.sidebar.toggleOpen,
        toggleCollapse: t.misc.conversations.sidebar.toggleCollapse,
        panels: t.misc.conversations.sidebar.panels,
      }}
      region={owner => (
        <>
          {/* 跟随开关只在宽的时候画：56px 轨上放不下一个带文字的复选框。 */}
          {owner.wide && <FollowTerminal />}
          <ConversationRows
            wide={owner.wide}
            activeId={selectedConversationId}
            onExpandSidebar={owner.expandSidebar}
            onOpen={conversation => {
              setFollowTerminalConversation(false);
              selectConversation(conversation.id);
              onEnterTerminal();
            }}
          />
        </>
      )}
    />
  );
}
