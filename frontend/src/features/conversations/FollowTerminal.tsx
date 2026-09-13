import { useEffect } from "react";
import { useTerminalConversation } from "./useTerminalConversation";
import { useWorkspace } from "../../shared/store";
import { t } from "@roost/i18n";

/**
 * 「跟随当前终端」开关。
 *
 * 后端**不会替前端切选择**：开关只是一个保存下来的偏好，真正的切换由这里发起，
 * 且只在 daemon 核验成功（200）之后才动。
 *
 * 最关键的一条：**409 时保持原样**。绝不退而求其次去 `?terminalId=` 的历史列表
 * 里取第一条当作当前身份——那是过去的关联，不是现在的位置，猜错就会把用户
 * 正在读的历史换成别的对话。
 */
export function FollowTerminal() {
  const { selectedId, followTerminalConversation, setFollowTerminalConversation, selectConversation } =
    useWorkspace("selectedId", "followTerminalConversation", "setFollowTerminalConversation", "selectConversation");
  const resolved = useTerminalConversation(followTerminalConversation ? selectedId : null);
  useEffect(() => {
    if (followTerminalConversation && resolved.current && resolved.conversationId) selectConversation(resolved.conversationId);
  }, [followTerminalConversation, resolved.current, resolved.conversationId, selectConversation]);
  const status = !selectedId ? t.misc.conversations.follow.noTerminal
    : !resolved.current ? t.misc.conversations.follow.noIdentity : null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2.5 py-1.5">
      <label className="flex items-center gap-2 text-caption text-text-dim">
        <input
          type="checkbox"
          checked={followTerminalConversation}
          onChange={event => setFollowTerminalConversation(event.target.checked)}
        />
        <span className="text-text">{t.misc.conversations.follow.label}</span>
      </label>
      {followTerminalConversation && status && (
        <div role="status" className="pl-6 text-caption text-text-dim/80"
          title={status === t.misc.conversations.follow.noIdentity ? t.misc.conversations.follow.noIdentityHint : undefined}>
          {status}
        </div>
      )}
    </div>
  );
}
