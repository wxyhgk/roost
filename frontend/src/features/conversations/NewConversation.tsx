import { useState } from "react";
import { createSession } from "../../shared/api/session";
import { useCliConfigs } from "../../shared/cli-configs";
import { useWorkspace } from "../../shared/store";
import { SessionLogo } from "../../shared/ui/SessionLogo";
import { t } from "@roost/i18n";

/**
 * 从 GUI 直接开一条新对话。
 *
 * **身份仍然由 CLI 产生，我们一个字都不铸。** 这里做的只是：新开一个终端，让它的第一个
 * 进程就是那个 CLI。CLI 起来后自己发 SessionStart 报出它的 session id，绑定、对话、run
 * 依次成立，输入框自然出现。所以这条路不依赖 `claude --session-id` 收不收一个全新的
 * UUID——那个问题在这里根本不存在。
 *
 * 起完之后把「跟随当前终端」打开并选中它：报到那一刻列表自己就切过去了，用这套现成的
 * 机制，而不是在这里另写一遍轮询。等待期间 `FollowTerminal` 会说明它在等什么。
 *
 * **只列用户配着的 CLI**，命令由后端按 id 从定义里取——前端不传 argv，那等于把任意
 * 命令执行开成接口。
 */
export function NewConversation() {
  const { configs, loading } = useCliConfigs();
  const { selectSession, setFollowTerminalConversation } =
    useWorkspace("selectSession", "setFollowTerminalConversation");
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const usable = configs.filter(config => config.enabled && config.command);

  async function start(cliId: string) {
    setStarting(cliId); setFailed(null);
    try {
      const session = await createSession({ startCli: cliId });
      // 先开跟随再选中：反过来会错过「选中时它恰好已经报到了」那一拍。
      setFollowTerminalConversation(true);
      selectSession(session.id);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : t.misc.conversations.newConversation.failed);
    } finally { setStarting(null); }
  }

  // 一个 CLI 都没有时不画一排空按钮——说清楚要去配一个。
  if (!loading && usable.length === 0) {
    return <p className="border-b border-border px-2.5 py-2 text-caption text-text-dim">
      {t.misc.conversations.newConversation.noCli}
    </p>;
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 text-caption text-text-dim">{t.misc.conversations.newConversation.label}</span>
        {usable.map(config => (
          <button key={config.id} type="button" disabled={starting !== null}
            title={`${config.name} · ${t.misc.conversations.newConversation.hint}`}
            onClick={() => void start(config.id)}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-caption text-text hover:bg-bg-hover disabled:opacity-60">
            <SessionLogo cliId={config.id} />
            <span>{config.name}</span>
          </button>
        ))}
      </div>
      {/*
        起完之后的等待状态**不在这里画**：选中新终端后 `FollowTerminal` 会说
        「当前终端还没有可识别的对话」，那正是此刻的真话，而且它的说明里已经写明
        不会从历史里猜一条顶上。这里再写一句只会和它打架，还会在 CLI 根本不上报时
        变成一句永远不兑现的承诺。
      */}
      {(starting !== null || failed) && (
        <p role="status" className="text-caption text-text-dim/70">
          {failed ?? t.misc.conversations.newConversation.starting}
        </p>
      )}
    </div>
  );
}
