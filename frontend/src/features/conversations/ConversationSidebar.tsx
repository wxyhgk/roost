import { ConversationRows } from "./ConversationRows";
import { FollowTerminal } from "./FollowTerminal";
import { useWorkspace } from "../../shared/store";

/**
 * 左栏的对话目录。
 *
 * 和目录浮层（`ConversationList`）的区别只有一条：**点一行不让列表让位**，
 * 而是让中栏切到那条对话。左栏的用处是「一列扫下来找回刚才那条」，找的过程中
 * 列表消失是反的。
 *
 * 点一行会**关掉「跟随当前终端」**。开着跟随时，`FollowTerminal` 会在终端身份变化时
 * 把选择改回终端正在跑的那条——你刚点开的历史会被它顶掉，看起来像点了没反应。
 * 想回到跟随，勾上面那个框就行。
 *
 * 点一行还会把中栏从画布切进终端视图（`onEnterTerminal`）——和工作区树点一个终端是
 * 同一个手势。**一个终端都没打开时中栏会被强制留在画布**（`TerminalPane` 那条兜底），
 * 这时点一行只会选中它，中栏不动：对话此刻没有可以挂靠的终端。
 */
export function ConversationSidebar({ onEnterTerminal }: { onEnterTerminal: () => void }) {
  const { selectConversation, setFollowTerminalConversation } =
    useWorkspace("selectConversation", "setFollowTerminalConversation");
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-panel">
      <FollowTerminal />
      <ConversationRows onOpen={conversation => {
        setFollowTerminalConversation(false);
        selectConversation(conversation.id);
        onEnterTerminal();
      }} />
    </div>
  );
}
