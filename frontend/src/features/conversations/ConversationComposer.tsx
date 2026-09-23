import type { PeerDetail } from "../../shared/api/conversations";
import { textBytes, viewOf, type Delivery } from "./outgoing";
import { MAX_DIRECT_INPUT_BYTES } from "@roost/terminal-protocol";
import type { DirectSend } from "./useDirectSend";
// 复用资料库那份 uid：它带了非安全上下文的 fallback（http 访问时 crypto.randomUUID
// 不存在），重写一份只会漏掉这个已经踩过的坑。
import { t } from "@roost/i18n";
import { useKeyboardInset } from "../../shared/useKeyboardInset";
import { queuedHint, queuedText } from "./deliveryReason";

/**
 * 发信区：往这个终端里的 CLI 直接打一句话。
 *
 * 原来这里是排队投递（202 不等于送达、requestId 跨重试沿用、待发区……），上面还挂着一条
 * 「TUI 输入框镜像」，显示旧写入闸的判断——「前面有一条还没确认，先不发新的」就是它说的。
 * 那条路上线以来零次成功投递，已经换掉（见 terminal-daemon/src/direct-input.ts）。
 * 现在一次发送就是一次完整的尝试，结果当场说清楚，只关于这一句。
 */
export function ConversationComposer({ send, onJump }: { send: DirectSend; onJump?: () => void }) {
  const { text, setText, busy, error, notice, submit } = send;
  const overLimit = textBytes(text) > MAX_DIRECT_INPUT_BYTES;
  const s = t.misc.conversations.detail.send;
  const keyboardInset = useKeyboardInset();

  return (
    /*
      手机上软键盘弹起来会盖住发信框。让出的高度只加在**这一侧**的 `padding-bottom` 上：
      发信区在 flex 列里本来就是 `shrink-0`，顶上那条 `flex-1` 的消息列表会自己缩。整个对话视图
      是 `TerminalPane` 里一层 `absolute inset-0` 的覆盖层（见那里「GUI 盖在终端之上」那段），
      所以这一截 padding 压根传不到终端容器上去，它的高度一个像素都没动——这正是
      `keyboardInset.ts` 顶上那条铁律要的效果。

      **是 padding 而不是 `position: fixed` / `transform`**：fixed 在 iOS 上以布局视口定位，
      键盘弹起时它照样停在被遮住的地方（这就是各家 App 的「输入框藏在键盘底下」那个经典 bug）；
      transform 则会把元素抬出正常流，上面的消息列表不知道它让了位，最后一条消息被盖住。
      留在正常流里顶上来，两个问题都不存在。
    */
    <div style={keyboardInset > 0 ? { paddingBottom: `calc(0.5rem + ${keyboardInset}px)` } : undefined}
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 py-2">
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}
      {notice && (
        <div role="status" className={`flex flex-wrap items-baseline gap-x-2 text-caption ${notice.tone === "ok" ? "text-text-dim" : "text-text"}`}>
          <span>{notice.text}</span>
          {notice.jump && onJump && (
            <button type="button" className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover" onClick={onJump}>{s.goTerminal}</button>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          rows={2}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            // Enter 换行，⌘/Ctrl+Enter 发送：这里的内容常常是多行的。
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
          }}
          placeholder={s.placeholder}
          className={`min-h-0 flex-1 resize-y rounded-md border bg-bg px-2 py-1.5 text-body text-text outline-none placeholder:text-text-dim/60 focus:border-accent ${
            overLimit ? "border-danger" : "border-border"
          }`}
        />
        <button type="button" disabled={busy || !text.trim() || overLimit} onClick={() => void submit()}
          className="shrink-0 rounded-md bg-bg-active px-3 py-2 text-caption text-text hover:bg-bg-hover disabled:opacity-40">
          {busy ? s.sending : s.send}
        </button>
      </div>
    </div>
  );
}

function label(delivery: Delivery) {
  const s = t.misc.conversations.detail.send;
  switch (delivery.state) {
    case "queued": return queuedText(delivery.reason);
    // 认领之后还可能卡在门口。有原因就说出来——没有原因才是「正在提交」。
    case "dispatching": return delivery.reason ? s.dispatchingBlocked(queuedText(delivery.reason)) : s.dispatching;
    case "accepted": return s.accepted;
    // P2：正文进了输入框但我们没按回车。它和「不知道写没写进去」是两件事，要分开说。
    case "uncertain": return delivery.reason === "awaiting_user_submit" ? s.awaitingUserSubmit : s.uncertain;
    case "failed": return s.failed;
    case "cancelled": return delivery.reason === "user_dismissed" ? s.dismissed : s.cancelled;
  }
}

export function PendingMessage({ detail, onCancel, onDismiss, onRemove, onRetry, onJump, readOnly = false }: {
  detail: PeerDetail;
  onCancel: (detail: PeerDetail) => void;
  onDismiss?: (detail: PeerDetail) => void;
  onRemove?: (detail: PeerDetail) => void;
  onRetry: () => void;
  onJump?: () => void;
  readOnly?: boolean;
}) {
  const view = viewOf(detail.delivery);
  const s = t.misc.conversations.detail.send;
  const hint = detail.delivery.state === "uncertain"
      ? (detail.delivery.reason === "awaiting_user_submit" ? s.awaitingUserSubmitHint : s.uncertainHint)
    : detail.delivery.state === "queued" || detail.delivery.state === "dispatching" ? queuedHint(detail.delivery.reason) : null;
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
        {/*
          要确认一下：放弃之后后面的消息会接着发，而这条若其实已经提交了，就会变成「发了但
          界面说放弃了」。能分辨的只有用户，所以把后果说清楚再让他按。
        */}
        {!readOnly && view.dismissable && onDismiss && (
          <button type="button" className="rounded px-1.5 py-0.5 text-text-dim hover:bg-bg-hover"
            onClick={() => { if (window.confirm(s.dismissConfirm)) onDismiss(detail); }}>{s.dismiss}</button>
        )}
        {!readOnly && view.retryable && (
          <button type="button" className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover" onClick={onRetry}>{s.retry}</button>
        )}
        {/*
          终态的出口。**不问确认**：它已经结束了，移除只是把它从待发区拿走，
          正文仍在消息记录里，按错了也没有后果——和「放弃」那一下不同。
        */}
        {!readOnly && view.removable && onRemove && (
          <button type="button" title={s.removeHint} className="rounded px-1.5 py-0.5 text-text-dim hover:bg-bg-hover"
            onClick={() => onRemove(detail)}>{s.remove}</button>
        )}
      </div>
      {hint && <div className="mt-0.5 text-caption text-text-dim/80">{hint}</div>}
    </div>
  );
}
