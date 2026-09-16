import type { PeerDetail } from "../../shared/api/conversations";
import { MAX_PEER_TEXT_BYTES, textBytes, viewOf, type Delivery } from "./outgoing";
import type { Outgoing } from "./useOutgoing";
// 复用资料库那份 uid：它带了非安全上下文的 fallback（http 访问时 crypto.randomUUID
// 不存在），重写一份只会漏掉这个已经踩过的坑。
import { t } from "@roost/i18n";
import { queuedHint, queuedText } from "./deliveryReason";

/**
 * 发信区。
 *
 * 三条硬约束，每一条都对应一种会造成实际损害的误读：
 *
 * 1. **202 不等于送达。** 真实状态看 `delivery.state`，界面措辞一律按最保守的解释来。
 * 2. **requestId 跨重试沿用。** 后端按它做幂等；换 ID 重发＝同一句话提交两次。
 * 3. **accepted 之后不再显示在待发区**，正文会从原生历史那条路出现——留着就是重复。
 */
/** 纯呈现：状态、提交、取消都由 useOutgoing 提供，待发列表由对话流负责渲染。 */
export function ConversationComposer({ outgoing }: { outgoing: Outgoing }) {
  const { text, setText, busy, error, submit } = outgoing;
  const overLimit = textBytes(text) > MAX_PEER_TEXT_BYTES;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 py-2">
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          rows={2}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            // Enter 换行，⌘/Ctrl+Enter 发送：这里的内容常常是多行的。
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
          }}
          placeholder={t.misc.conversations.detail.send.placeholder}
          className={`min-h-0 flex-1 resize-y rounded-md border bg-bg px-2 py-1.5 text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent ${
            overLimit ? "border-danger" : "border-border"
          }`}
        />
        <button type="button" disabled={busy || !text.trim() || overLimit} onClick={() => void submit()}
          className="shrink-0 rounded-md bg-bg-active px-3 py-2 text-caption text-text hover:bg-bg-hover disabled:opacity-40">
          {busy ? t.misc.conversations.detail.send.sending : t.misc.conversations.detail.send.send}
        </button>
      </div>
    </div>
  );
}

function label(delivery: Delivery) {
  const s = t.misc.conversations.detail.send;
  switch (delivery.state) {
    case "queued": return queuedText(delivery.reason);
    case "dispatching": return s.dispatching;
    case "accepted": return s.accepted;
    // P2：正文进了输入框但我们没按回车。它和「不知道写没写进去」是两件事，要分开说。
    case "uncertain": return delivery.reason === "awaiting_user_submit" ? s.awaitingUserSubmit : s.uncertain;
    case "failed": return s.failed;
    case "cancelled": return s.cancelled;
  }
}

export function PendingMessage({ detail, onCancel, onRetry, onJump, readOnly = false }: {
  detail: PeerDetail;
  onCancel: (detail: PeerDetail) => void;
  onRetry: () => void;
  onJump?: () => void;
  readOnly?: boolean;
}) {
  const view = viewOf(detail.delivery);
  const s = t.misc.conversations.detail.send;
  const hint = detail.delivery.state === "uncertain"
      ? (detail.delivery.reason === "awaiting_user_submit" ? s.awaitingUserSubmitHint : s.uncertainHint)
    : detail.delivery.state === "queued" ? queuedHint(detail.delivery.reason) : null;
  return (
    <div className="rounded-md border border-border bg-bg-raised px-2 py-1.5">
      <div className="truncate text-caption text-text-dim">{detail.message.preview ?? detail.message.text}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-caption">
        <span className={detail.delivery.state === "failed" ? "text-danger" : "text-text-dim"}>{label(detail.delivery)}</span>
        {view.jumpToTerminal && onJump && (
          <button type="button" className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover" onClick={onJump}>{s.goTerminal}</button>
        )}
        {!readOnly && view.cancellable && (
          <button type="button" className="rounded px-1.5 py-0.5 text-text-dim hover:bg-bg-hover" onClick={() => onCancel(detail)}>{s.cancel}</button>
        )}
        {!readOnly && view.retryable && (
          <button type="button" className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover" onClick={onRetry}>{s.retry}</button>
        )}
      </div>
      {hint && <div className="mt-0.5 text-caption text-text-dim/80">{hint}</div>}
    </div>
  );
}
