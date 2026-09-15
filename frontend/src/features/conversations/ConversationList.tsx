import { useEffect, useState } from "react";
import { fetchConversation, type Conversation } from "../../shared/api/conversations";
import { ConversationDetail } from "./ConversationDetail";
import { ConversationRows } from "./ConversationRows";
import { FollowTerminal } from "./FollowTerminal";
import { useWorkspace } from "../../shared/store";

/**
 * 对话目录，**列表和详情在同一块地方轮流出现**。
 *
 * 这是目录浮层（`ConversationCatalog`）用的形状：那是一个 720px 宽的对话框，
 * 分栏两边都放不下，所以详情整块替换列表，列表状态留在这里、返回时不用重新加载。
 *
 * 左栏里用的是另一个形状（`ConversationSidebar`）——那边点一行是让**中栏**切过去，
 * 列表自己不让位。两边共用的列表实现在 `ConversationRows`。
 *
 * **独立于终端**：这里列的是已保存的对话，终端关掉、CLI 退出，它们仍然在。
 * 打开一个对话只读历史，不会启动任何 CLI。
 */
export function ConversationList() {
  // 对话选择存在工作区偏好里，**不放组件局部状态**：切换终端、关掉终端、
  // 甚至刷新页面，选中的对话都该还在——这正是「独立选择」的含义。
  const { selectSession, selectedConversationId, selectConversation } =
    useWorkspace("selectSession", "selectedConversationId", "selectConversation");
  const open = useSelectedConversation(selectedConversationId);

  if (open && open.id === selectedConversationId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col"><FollowTerminal /><ConversationDetail key={open.id}
        conversation={open}
        onBack={() => selectConversation(null)}
        onJumpToTerminal={sessionId => { selectSession(sessionId); }}
      /></div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FollowTerminal />
      <ConversationRows onOpen={conversation => selectConversation(conversation.id)} />
    </div>
  );
}

/**
 * 偏好里存的是 ID，详情要的是完整对象——按 ID 取一次。
 *
 * 不从列表结果里找：那样会让「选中的对话」因为翻页翻不到而显示不出来，而列表现在
 * 是另一个组件的私事了。取不到就当没选中——对话可能已被删除，而不是界面坏了。
 */
function useSelectedConversation(id: string | null): Conversation | null {
  const [open, setOpen] = useState<Conversation | null>(null);
  useEffect(() => {
    if (!id) { setOpen(null); return; }
    let cancelled = false;
    void fetchConversation(id)
      .then(found => { if (!cancelled) setOpen(found); })
      .catch(() => { if (!cancelled) setOpen(null); });
    return () => { cancelled = true; };
  }, [id]);
  return open;
}
