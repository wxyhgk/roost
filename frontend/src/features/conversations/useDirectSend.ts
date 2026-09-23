import { useCallback, useEffect, useRef, useState } from "react";
import { typeIntoTerminal } from "../../shared/api/conversations";
import { noticeOf, type DirectNotice } from "./directSend";

/** 发成了的那句确认停多久。其余提示不自己消失——它们是要你去做点什么的。 */
const OK_NOTICE_MS = 3000;

/**
 * 往一个终端里直接打字。
 *
 * 没有队列、没有 requestId、没有重试：每一次点发送就是一次「贴 → 看见 → 回车」，结果当场
 * 回来。旧的投递路径要 requestId 跨重试沿用，是因为它要防「同一句提交两次」；这里一次请求
 * 就是一次完整的尝试，失败了原文还在输入框里，用户自己看着改、看着再发。
 *
 * 换终端就把状态清掉：上一个终端的提示挂在新终端的输入框上，就是一句假话。
 */
export function useDirectSend(terminalId: string | null) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<DirectNotice | null>(null);
  const target = useRef(terminalId);
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    target.current = terminalId;
    setBusy(false); setError(null); setNotice(null);
    return () => clearTimeout(fade.current);
  }, [terminalId]);

  const submit = useCallback(async () => {
    const id = terminalId;
    if (!id || busy || !text.trim()) return;
    setBusy(true); setError(null); setNotice(null); clearTimeout(fade.current);
    try {
      const result = await typeIntoTerminal(id, text);
      if (target.current !== id) return;
      const next = noticeOf(result);
      if (next.clear) setText("");
      setNotice(next);
      if (next.tone === "ok") fade.current = setTimeout(() => setNotice(current => current === next ? null : current), OK_NOTICE_MS);
    } catch (err) {
      if (target.current === id) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (target.current === id) setBusy(false);
    }
  }, [terminalId, busy, text]);

  return { terminalId, text, setText, busy, error, notice, submit };
}

export type DirectSend = ReturnType<typeof useDirectSend>;
