import { useCallback, useSyncExternalStore } from 'react';

// 一屏会话共用一个计时器：每行各起一个 interval 会白白唤醒主线程。
const listeners = new Set<() => void>();
let timer = 0;
let nowValue = Date.now();

function subscribeTick(fn: () => void) {
  listeners.add(fn);
  if (!timer && typeof window !== 'undefined') {
    nowValue = Date.now();
    timer = window.setInterval(() => {
      nowValue = Date.now();
      for (const listener of [...listeners]) listener();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { window.clearInterval(timer); timer = 0; }
  };
}
const noop = () => () => {};
const readNow = () => nowValue;

/**
 * 已静默的毫秒数；lastOutputAt 为 null（例如后端刚重启，观测记录还没重建）时返回 null。
 * 用绝对时间戳相减而不是累加计数：标签页被挂起时 interval 会被节流，累加会偏小。
 */
export function useQuietFor(lastOutputAt: number | null): number | null {
  // 没有时间戳的行不订阅，避免正在刷屏的会话也跟着每秒重渲染。
  const subscribe = useCallback((fn: () => void) => (lastOutputAt === null ? noop() : subscribeTick(fn)), [lastOutputAt]);
  const now = useSyncExternalStore(subscribe, readNow, readNow);
  return lastOutputAt === null ? null : Math.max(0, now - lastOutputAt);
}
