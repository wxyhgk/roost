import { useCallback, useSyncExternalStore } from "react";
import { getTerminalHandle, subscribeTerminalHandle } from "./public";
import type { TermHandle } from "./types";

/**
 * 订阅某个会话的终端句柄。
 *
 * 句柄是会换的：终端重挂、重连、换实例都会重新注册，所以不能取一次就存着。
 * 这层订阅原本抄在每个需要句柄的组件里，抄一次就是三行 useCallback +
 * useSyncExternalStore 的样板。
 */
export function useTerminalHandle(sessionId: string | null | undefined): TermHandle | null {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeTerminalHandle(sessionId, listener) : () => {}),
    [sessionId],
  );
  const read = useCallback(() => (sessionId ? getTerminalHandle(sessionId) ?? null : null), [sessionId]);
  return useSyncExternalStore(subscribe, read, read);
}
