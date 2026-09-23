import { useCallback, useEffect, useRef, useState } from "react";
import { cancelDelivery, dismissDelivery, removeDelivery, fetchInbox, fetchPeerMessage, sendToConversation, type PeerDetail } from "../../shared/api/conversations";
import { ApiError } from "../../shared/api/errors";
import { MAX_PEER_TEXT_BYTES, pendingOutgoing, textBytes } from "./outgoing";
import { uid } from "../../shared/uid";
import { t } from "@roost/i18n";

/**
 * 发出去的消息：状态、提交、取消、重试。
 *
 * **抽成 hook 是因为它有两个消费者。** 输入框要它来提交和显示错误；对话流要它把待发的
 * 消息渲染在**末尾**——那条消息本来就属于这条流的末尾（它会进 TUI，再从 transcript 回来），
 * 摆进输入框上方一个单独的托盘，等于让用户在两个地方对照着看自己刚发的话。
 */
export function useOutgoing(conversationId: string) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<PeerDetail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // requestId 存这里：网络失败重试时必须是同一个，所以不能每次提交都新生成。
  const attempt = useRef<{ requestId: string; text: string } | null>(null);
  const scope = useRef<{ id: string; controller: AbortController } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = { id: conversationId, controller };
    setItems([]); setError(null); setBusy(false); attempt.current = null;
    void fetchInbox(conversationId, 20, controller.signal)
      .then(page => { if (!controller.signal.aborted) setItems(page.items); }).catch(() => undefined);
    return () => { controller.abort(); };
  }, [conversationId]);

  const merge = useCallback((detail: PeerDetail) => {
    setItems(previous => {
      const next = previous.filter(item => item.message.id !== detail.message.id);
      return [...next, detail];
    });
  }, []);

  const submit = useCallback(async () => {
    const current = scope.current;
    if (!current || current.id !== conversationId || current.controller.signal.aborted) return;
    const body = attempt.current?.text ?? text;
    if (!body.trim() || busy) return;
    if (textBytes(body) > MAX_PEER_TEXT_BYTES) { setError(t.misc.conversations.detail.send.tooLong); return; }
    // 首次提交生成 ID；重试时沿用——后端按 requestId 幂等，换 ID 就是提交两次。
    const requestId = attempt.current?.requestId ?? uid();
    attempt.current = { requestId, text: body };
    setBusy(true); setError(null);
    try {
      const detail = await sendToConversation(conversationId, requestId, body);
      if (current.controller.signal.aborted) return;
      merge(detail);
      // 只有服务端确实收下了才清空输入框和这一轮的 requestId。
      attempt.current = null;
      setText("");
    } catch (err) {
      if (current.controller.signal.aborted) return;
      // 同 ID 不同正文：后端拒绝覆盖。这时必须换一条新的，不能静默改写。
      if (err instanceof ApiError && err.status === 409) {
        attempt.current = null;
        setError(t.misc.conversations.detail.send.conflict);
      } else {
        // 网络失败：保留 requestId 和原文，重试走同一条逻辑请求。
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally { if (!current.controller.signal.aborted) setBusy(false); }
  }, [conversationId, text, busy, merge]);

  const cancel = useCallback(async (detail: PeerDetail) => {
    const current = scope.current;
    if (!current || current.id !== conversationId || current.controller.signal.aborted) return;
    try {
      const result = await cancelDelivery(detail.delivery.id);
      if (!current.controller.signal.aborted) merge(result);
    } catch (err) {
      if (current.controller.signal.aborted) return;
      // 409 already_dispatching：已经来不及取消了。回读最新状态而不是报错了事——
      // 此刻它可能已经 dispatching 甚至 accepted，用户需要看到的是那个。
      if (err instanceof ApiError && err.status === 409) {
        const latest = await fetchPeerMessage(detail.message.id, current.controller.signal).catch(() => null);
        if (latest && !current.controller.signal.aborted) merge(latest);
      } else setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, merge]);

  // 和 cancel 同一个形状：409 not_uncertain 说明它已经自己落定了（回执到了、或被别处处理了），
  // 回读最新状态给用户看，而不是报错。
  const dismiss = useCallback(async (detail: PeerDetail) => {
    const current = scope.current;
    if (!current || current.id !== conversationId || current.controller.signal.aborted) return;
    try {
      const result = await dismissDelivery(detail.delivery.id);
      if (!current.controller.signal.aborted) merge(result);
    } catch (err) {
      if (current.controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 409) {
        const latest = await fetchPeerMessage(detail.message.id, current.controller.signal).catch(() => null);
        if (latest && !current.controller.signal.aborted) merge(latest);
      } else setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, merge]);

  /*
    「从待发区拿走」。和 cancel / dismiss 同一个形状：409 说明它已经不是终态了
    （极少见，比如别处重试过），回读最新状态给用户看，而不是报错。
  */
  const remove = useCallback(async (detail: PeerDetail) => {
    const current = scope.current;
    if (!current || current.id !== conversationId || current.controller.signal.aborted) return;
    try {
      const result = await removeDelivery(detail.delivery.id);
      if (!current.controller.signal.aborted) merge(result);
    } catch (err) {
      if (current.controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 409) {
        const latest = await fetchPeerMessage(detail.message.id, current.controller.signal).catch(() => null);
        if (latest && !current.controller.signal.aborted) merge(latest);
      } else setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, merge]);

  return { text, setText, items, pending: pendingOutgoing(items), busy, error, submit, cancel, dismiss, remove };
}

export type Outgoing = ReturnType<typeof useOutgoing>;
