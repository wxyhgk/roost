import type { SendResult, TermHandle, TermStatus } from "./types";
import { clearTerminalStatus, setTerminalLatency, setTerminalStatus } from "./status";

/**
 * 一个会话在挂载期间对外留下的全部登记项。
 *
 * **这几张表刻意放在同一个文件里。** 它们看着不相干——渲染句柄、输入入口、附件落点——
 * 但底部的 `claimTerminalSession` 要求它们同生同死：一次新的挂载接管整个会话，
 * 必须把上一次留下的每一项都清干净，漏掉任何一张表，旧终端就会继续吃到本该属于
 * 新终端的输入或附件。分成几个模块之后，这条不变量就没有一个能看见全貌的地方，
 * 下一个人加第七张表时不会知道还要回来改这里。
 *
 * 状态与延迟不在此列：它们只通过 `status.ts` 的函数被碰，所以拆出去了。
 */

// 会话级终端句柄：TermView 挂载时 set，TerminalPane 的导出/查找按钮按 selectedId 取用。
const terminalHandles = new Map<string, TermHandle>();
const handleListeners = new Map<string, Set<() => void>>();
// 会话级输入入口：useTerminal 注册 conn.sendInput，笔记/片段等面板按 selectedId 发送文本。
const terminalInputs = new Map<string, (data: string) => SendResult>();
export type AttachmentTarget = { sessionId: string; instanceId: string; epoch: number };
const attachmentTargets = new Map<string, () => AttachmentTarget | null>();

export function getTerminalHandle(id: string) { return terminalHandles.get(id); }

export function subscribeTerminalHandle(id: string, listener: () => void) {
  const listeners = handleListeners.get(id) ?? new Set<() => void>();
  handleListeners.set(id, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) handleListeners.delete(id); };
}

export function registerTerminal(id: string, handle: TermHandle) {
  terminalHandles.set(id, handle); handleListeners.get(id)?.forEach(fn => fn());
  return () => {
    if (terminalHandles.get(id) !== handle) return;
    terminalHandles.delete(id); handleListeners.get(id)?.forEach(fn => fn());
  };
}

/** 句柄换了就要重新挂选区监听——选区是句柄身上的，旧句柄的订阅在新句柄上不成立。 */
export function subscribeSelection(id: string, listener: () => void) {
  let current: { dispose(): void } | undefined;
  const attach = () => { current?.dispose(); current = getTerminalHandle(id)?.onSelectionChange(listener); listener(); };
  const unsubscribe = subscribeTerminalHandle(id, attach); attach();
  return () => { unsubscribe(); current?.dispose(); };
}

export function setTerminalInput(id: string, send: (data: string) => SendResult) {
  terminalInputs.set(id, send);
}

export function clearTerminalInput(id: string) {
  terminalInputs.delete(id);
}

export function sendToSession(id: string, data: string): SendResult {
  const send = terminalInputs.get(id);
  if (!send || !data) return "rejected";
  return send(data);
}

export function getAttachmentTarget(id: string) { return attachmentTargets.get(id)?.() ?? null; }

/** 清掉一个会话在上面每一张表里的登记。**新增登记项时这里必须跟着加。** */
function releaseRegistrations(id: string) {
  terminalInputs.delete(id);
  attachmentTargets.delete(id);
  if (terminalHandles.delete(id)) handleListeners.get(id)?.forEach(fn => fn());
}

// A replacement mount owns all session registrations, not just the renderer.
const sessionOwners = new Map<string, symbol>();
export function claimTerminalSession(id: string) {
  const token = Symbol(id);
  sessionOwners.set(id, token);
  releaseRegistrations(id);
  const current = () => sessionOwners.get(id) === token;
  return {
    current,
    register(handle: TermHandle, send: (data: string) => SendResult, target?: () => AttachmentTarget | null) {
      if (!current()) return;
      registerTerminal(id, handle); setTerminalInput(id, send);
      if (target) attachmentTargets.set(id, target);
    },
    status(value: TermStatus) { if (current()) setTerminalStatus(id, value); },
    latency(milliseconds: number) { if (current()) setTerminalLatency(id, milliseconds); },
    dispose() {
      if (!current()) return;
      sessionOwners.delete(id);
      releaseRegistrations(id);
      clearTerminalStatus(id);
    },
  };
}
