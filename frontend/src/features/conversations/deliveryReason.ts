import { t } from "@roost/i18n";

/**
 * 排队原因 → 人话。
 *
 * 之前这里只认 `terminal_draft` / `busy` / `dialog`，其余一律落到
 * `queuedOther(reason)`，于是用户看到的是「暂时不能投递（disabled）」这种把内部标识
 * 原样漏出来的句子——既看不懂，也不知道该干什么。而这些原因来自
 * `terminal-daemon/src/ai-command-owner.ts` 的 `reason()` 与 `peer-delivery.ts` 的 pump，
 * 是一个**封闭集合**，没有理由不逐条给说法。
 *
 * **`pending` 不是一个阻塞原因。** 它是往 `peer_deliveries` 插入时钉的初始值
 * （`peer-messages.ts`），意思是「刚入队，daemon 还没轮到它」。把它当理由显示，等于把
 * 「正常排队中」说成「不能投递」。它在这里被当成没有原因处理。
 *
 * 认不出的原因仍然原样带出来（`queuedOther`）——**不假装知道它是什么**。
 */
const TEXT: Record<string, string> = {};
const HINT: Record<string, string> = {};
function build() {
  const r = t.misc.conversations.detail.send.queuedReason, s = t.misc.conversations.detail.send;
  Object.assign(TEXT, {
    terminal_draft: s.queuedDraft, busy: s.queuedBusy, dialog: s.queuedDialog,
    disabled: r.disabled, unsupported_version: r.unsupportedVersion, unsupported_cli: r.unsupportedCli,
    terminal_exited: r.terminalExited, recipient_offline: r.recipientOffline,
    identity_unconfirmed: r.identityUnconfirmed, screen_unavailable: r.screenUnavailable,
    screen_unknown: r.screenUnknown, terminal_input: r.terminalInput, command_pending: r.commandPending,
    message_not_submittable: r.notSubmittable, conversation_trashed: r.conversationTrashed,
    lifecycle_unavailable: r.lifecycleUnavailable, transcript_unavailable: r.transcriptUnavailable,
    transport_unavailable: r.transportUnavailable,
  });
  Object.assign(HINT, { disabled: r.disabledHint, unsupported_version: r.unsupportedVersionHint });
}

/** 这条排队消息现在卡在什么上。`reason` 为 null 或 `pending` 都表示「正常排队」。 */
export function queuedText(reason: string | null): string {
  const s = t.misc.conversations.detail.send;
  if (!reason || reason === "pending") return s.queued;
  build();
  return TEXT[reason] ?? s.queuedOther(reason);
}

/** 只有「你能动手改变它」的两种才给补充说明，其余不堆字。 */
export function queuedHint(reason: string | null): string | null {
  if (!reason || reason === "pending") return null;
  build();
  return HINT[reason] ?? null;
}
