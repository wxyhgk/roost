import type { TermStatus } from "./types";

/**
 * 每个会话的连接状态与往返延迟。
 *
 * 从 `handles.ts` 拆出来：那边剩下的几张表都被 `claimTerminalSession` 直接操作，
 * 而这两张只通过下面这几个函数被碰，所以能整块搬走而不动那条所有权不变量。
 *
 * 订阅是**全局一份**而不是按会话：唯一的消费者是底栏，它一次要看当前选中终端的
 * 状态和延迟，按会话订阅只会让它自己去管一堆订阅的生命周期。
 */
const terminalStatuses = new Map<string, TermStatus>();
const terminalLatencies = new Map<string, { milliseconds: number; sampledAt: number }>();
const statusListeners = new Set<() => void>();

function emitStatus() {
  for (const fn of statusListeners) fn();
}

export function getTerminalStatus(id: string): TermStatus | null {
  return terminalStatuses.get(id) ?? null;
}

export function setTerminalStatus(id: string, status: TermStatus) {
  if (terminalStatuses.get(id) === status) return;
  terminalStatuses.set(id, status);
  // 一旦不是 open，上一次量到的延迟就不再代表任何东西，留着只会让底栏显示一个陈旧数字。
  if (status !== 'open') terminalLatencies.delete(id);
  emitStatus();
}

export function clearTerminalStatus(id: string) {
  terminalLatencies.delete(id);
  if (terminalStatuses.delete(id)) emitStatus();
}

export function getTerminalLatency(id: string) { return terminalLatencies.get(id) ?? null; }

export function setTerminalLatency(id: string, milliseconds: number) {
  if (terminalStatuses.get(id) !== 'open' || !Number.isFinite(milliseconds) || milliseconds < 0) return;
  terminalLatencies.set(id, { milliseconds: Math.round(milliseconds), sampledAt: Date.now() });
  emitStatus();
}

export function subscribeTerminalStatus(fn: () => void) {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}
