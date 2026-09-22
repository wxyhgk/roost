import { useState } from "react";
import { patchConversation, type Conversation } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { useCliIdentity } from "../../shared/ui/SessionLogo";
import { useWorkspace } from "../../shared/store";
import { writeClipboard } from "../../shared/clipboard";
import { formatTime } from "../../shared/datetime";
import { t } from "@roost/i18n";

/**
 * 对话的详细信息与管理操作。
 *
 * 存在的理由很直接：目录里标题大量重复（真实数据 17 条有 10 条叫「前端」），
 * 光看列表分不出是哪个 CLI、哪个目录、哪条会话。这里把这些如实摆出来，
 * 并允许**改标题和归入分组**——那才是真正解决重名的办法，而不是继续在展示上想办法。
 */
export function ConversationMeta({ conversation, onChanged }: {
  conversation: Conversation;
  onChanged: (next: Conversation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { projects } = useWorkspace("projects");
  const identity = useCliIdentity(null, conversation.source.cliId);
  const m = t.misc.conversations.meta;

  async function apply(patch: Parameters<typeof patchConversation>[2]) {
    setBusy(true); setMessage(null);
    try {
      onChanged(await patchConversation(conversation.id, conversation.revision, patch));
      setRenaming(null);
    } catch (error) {
      // 409：别处刚改过，响应体里带着服务端此刻的真实值。用它刷新界面，
      // 让用户在新值上重做——静默覆盖会把别处的修改抹掉。
      if (error instanceof ApiError && error.status === 409) {
        const current = (error.body as { current?: Conversation } | null)?.current;
        if (current) onChanged(current);
        setMessage(m.conflict);
      } else {
        setMessage(error instanceof Error ? error.message : m.failed);
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="border-b border-border">
      <button type="button" onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1 text-caption text-text-dim hover:bg-bg-hover hover:text-text">
        <span>{open ? m.hide : m.show}</span>
        <span className="text-text-dim/70">{identity.label}</span>
        {conversation.pinnedAt && <span className="text-text-dim/70">★</span>}
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2">
          <Field label={m.cli} value={identity.label} />
          {conversation.source.cwd && <Field label={m.folder} value={conversation.source.cwd} copyable />}
          {/* ID 平时用不到，但排查问题时是唯一能对上号的东西，所以给出并可复制。 */}
          <Field label={m.conversationId} value={conversation.id} copyable mono />
          <Field label={m.nativeId} value={conversation.source.nativeSessionId} copyable mono />
          <Field label={m.created} value={formatTime(conversation.createdAt)} />
          {conversation.lastMessageAt && <Field label={m.lastMessage} value={formatTime(conversation.lastMessageAt)} />}

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {renaming === null ? (
              <button type="button" disabled={busy} className={action} onClick={() => setRenaming(conversation.title)}>{m.rename}</button>
            ) : (
              <>
                <input
                  autoFocus
                  value={renaming}
                  maxLength={200}
                  placeholder={m.renamePlaceholder}
                  onChange={event => setRenaming(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter" && renaming.trim()) { event.preventDefault(); void apply({ title: renaming.trim() }); }
                    if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body text-text outline-none focus:border-accent"
                />
                <button type="button" disabled={busy || !renaming.trim()} className={action}
                  onClick={() => void apply({ title: renaming.trim() })}>{m.save}</button>
                <button type="button" className={action} onClick={() => setRenaming(null)}>{m.cancel}</button>
              </>
            )}

            {/* 分组复用工作区已有的分组，而不是另造一套——两边指的是同一件事。 */}
            <label className="flex items-center gap-1 text-caption text-text-dim">
              <span>{m.group}</span>
              <select
                value={conversation.projectId ?? ""}
                disabled={busy}
                onChange={event => void apply({ projectId: event.target.value || null })}
                // 和同一行里的重命名输入框是同一种控件（h-7 的框），字号跟着它走 text-body；
                // 外面那圈 text-caption 是标签和小按钮，不是控件本身。
                className="h-7 rounded-md border border-border bg-bg px-1 text-body text-text outline-none focus:border-accent"
              >
                <option value="">{m.noGroup}</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>

            <button type="button" disabled={busy} className={action}
              onClick={() => void apply({ pinned: !conversation.pinnedAt })}>
              {conversation.pinnedAt ? m.unpin : m.pin}
            </button>
          </div>

          {message && <div role="alert" className="text-caption text-warning">{message}</div>}
        </div>
      )}
    </div>
  );
}

const action = "shrink-0 rounded px-2 py-1 text-caption text-text hover:bg-bg-hover disabled:opacity-40";

function Field({ label, value, copyable, mono }: { label: string; value: string; copyable?: boolean; mono?: boolean }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  return (
    <div className="flex items-baseline gap-2 text-caption">
      <span className="w-20 shrink-0 text-text-dim/70">{label}</span>
      <span className={`min-w-0 flex-1 break-all text-text-dim ${mono ? "font-mono" : ""}`}>{value}</span>
      {copyable && (
        <button type="button" className="shrink-0 rounded px-1 text-text-dim hover:bg-bg-hover hover:text-text"
          onClick={() => void writeClipboard(value).then(ok => setCopied(ok ? "ok" : "fail"))}>
          {copied === "ok" ? t.misc.conversations.meta.copied : copied === "fail" ? t.misc.conversations.meta.copyFailed : t.misc.conversations.meta.copy}
        </button>
      )}
    </div>
  );
}
