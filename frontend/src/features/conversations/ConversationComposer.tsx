import type { PeerDetail } from "../../shared/api/conversations";
import { MAX_PEER_TEXT_BYTES, textBytes, viewOf, type Delivery } from "./outgoing";
import type { Outgoing } from "./useOutgoing";
import { InputBar } from "../../vendor/dsh/skeleton/InputBar";
// 复用资料库那份 uid：它带了非安全上下文的 fallback（http 访问时 crypto.randomUUID
// 不存在），重写一份只会漏掉这个已经踩过的坑。
import { t } from "@roost/i18n";

/**
 * 发信区。
 *
 * 三条硬约束，每一条都对应一种会造成实际损害的误读：
 *
 * 1. **202 不等于送达。** 真实状态看 `delivery.state`，界面措辞一律按最保守的解释来。
 * 2. **requestId 跨重试沿用。** 后端按它做幂等；换 ID 重发＝同一句话提交两次。
 * 3. **accepted 之后不再显示在待发区**，正文会从原生历史那条路出现——留着就是重复。
 */
/**
 * 输入卡的接线。
 *
 * **画面整个是 `vendor/dsh/skeleton/InputBar`**（上游 deepseek-harness 那张 22px 圆角的
 * 胶囊），我们自己那套容器、边框、textarea 样式、发送按钮全部退场了——原来的写法是在
 * 自己的壳上贴别人的样式，形状永远对不上（`ConversationRoot.module.css` 的几何按上游那张
 * 卡算的：座位给 `--dsh-composer-text-max-height`、根给 `--dsh-composer-card-max-width`，
 * 只有真用那张卡这两条才落得下去）。
 *
 * **行为一侧一个字没动**：提交仍旧走 `useOutgoing.submit`（requestId 幂等、409 冲突不改写、
 * 网络失败保留原 ID 重试），待发列表仍旧由对话流渲染成 `PendingMessage`，⌘/Ctrl+Enter
 * 发送这个既有键位也保留（在 InputBar 里，见那个文件的 ROOST-CHANGE 7）。
 *
 * 喂过去的只有四样：草稿、提交、提交中、以及那条横幅。附件、模型选择、模式（计划/普通）、
 * `@` 和斜杠菜单一律不传——按 NOTICE.md「没搬什么」的规矩，喂不满就不画，prop 留在
 * `InputBarProps` 里等数据。
 */
export function ConversationComposer({ outgoing }: { outgoing: Outgoing }) {
  const { text, setText, busy, error, submit } = outgoing;
  const s = t.misc.conversations.detail.send;
  const overLimit = textBytes(text) > MAX_PEER_TEXT_BYTES;

  return (
    <InputBar
      draft={text}
      onDraftChange={setText}
      onSubmit={() => void submit()}
      placeholder={s.placeholder}
      // 钮上只有一个箭头，可读名字得自己给；提交中换成「提交中…」，读屏才知道点下去了。
      sendLabel={busy ? s.sending : s.send}
      phase={busy ? "submitting" : "plain"}
      // 超限时输入不锁——用户得能把内容删到能发为止；锁住的只有发送闸门。
      sendBlocked={overLimit}
      /*
        上游把错误送进 Toast，那个 primitive 没搬（NOTICE.md）。这里合到卡片上方那条
        横幅里：超限是当下就能自己解决的，`error` 是服务端/网络刚回的，两者不会同时
        有意义——先报刚发生的那个。
      */
      notice={error ? { level: "error", text: error } : overLimit ? { level: "error", text: s.tooLong } : null}
    />
  );
}

function label(delivery: Delivery) {
  const s = t.misc.conversations.detail.send;
  switch (delivery.state) {
    case "queued":
      return delivery.reason === "terminal_draft" ? s.queuedDraft
        : delivery.reason === "busy" ? s.queuedBusy
        : delivery.reason === "dialog" ? s.queuedDialog
        // 未知原因保守兜底：把服务端说法原样带出来，不假装知道它是什么。
        : delivery.reason ? s.queuedOther(delivery.reason) : s.queued;
    case "dispatching": return s.dispatching;
    case "accepted": return s.accepted;
    case "uncertain": return s.uncertain;
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
  const hint = detail.delivery.state === "uncertain" ? s.uncertainHint : null;
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
