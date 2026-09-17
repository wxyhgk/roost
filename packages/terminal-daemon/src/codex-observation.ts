import WebSocket from 'ws';
import { connect } from 'node:net';

/*
  Codex 的状态观察者。

  和 claude / qwen / opencode 三家都不同：**观察者住在守护进程里，不在启动垫片里。**
  codex 的 app-server 只认 WebSocket 升级（裸行 JSON-RPC 发过去一个字节都不回，实测），
  而垫片是写进临时目录的一段模板字符串，没有模块解析、拿不到 `ws`。手写一个 WebSocket
  客户端塞进模板里要百来行帧解析，放在这里则是一句 import——而且能正常单测。

  垫片只负责三件事：起一个私有 app-server、把 socket 路径报给守护进程、用 `--remote`
  把 TUI 接上去。**那条 socket 上只有这一个 TUI，所以它创建的也只有这一个 thread**，
  归属不用猜——官方文档说的「第三方观察者无法确定 TUI 和 thread 的对应关系」，破法就在
  这里（见 tasks/cli-adapters/codex-observer-feasibility.md）。
*/

/** 认得出来的 socket 路径形状。太长的连 bind 都做不到（SUN_LEN，macOS 104 字节）。 */
export const MAX_CODEX_SOCKET_PATH = 104;

/**
 * 一条 `ServerNotification` → 我们的 agent 事件名。
 *
 * **只认 `thread/status/changed` 和 `thread/started`**，因为只有线程级通知是广播的：
 * 实测被动连接（没调 `thread/resume`）收得到它们，收不到 `turn/*` 和 `item/*`。而
 * `ThreadStatus` 恰好把我们要的四个状态都带齐了，连「在等你批准 / 在等你回答」都在
 * `activeFlags` 里——所以不需要订阅，也不需要轮询。
 */
export function codexAgentEvent(message: unknown): { event: string; threadId: string } | null {
  const row = message as { method?: unknown; params?: Record<string, unknown> } | null;
  if (!row || typeof row.method !== 'string' || !row.params) return null;
  if (row.method === 'thread/started') {
    const thread = row.params.thread as { id?: unknown } | undefined;
    return validThreadId(thread?.id) ? { event: 'session_start', threadId: thread!.id as string } : null;
  }
  if (row.method !== 'thread/status/changed') return null;
  const threadId = row.params.threadId;
  const status = row.params.status as { type?: unknown; activeFlags?: unknown } | undefined;
  if (!validThreadId(threadId) || !status || typeof status.type !== 'string') return null;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  switch (status.type) {
    case 'active':
      // 有旗标就是在等人，没有就是在干活。旗标同时有两个时先报批准——那个更挡路。
      if (flags.includes('waitingOnApproval')) return { event: 'permission_request', threadId: threadId as string };
      if (flags.includes('waitingOnUserInput')) return { event: 'question_asked', threadId: threadId as string };
      return { event: 'prompt_submit', threadId: threadId as string };
    // `systemError` 也算收尾：这一回合不会再动了，不把它单独做成一个状态。
    case 'idle': case 'systemError': return { event: 'stop', threadId: threadId as string };
    // `notLoaded` 是「这条 thread 不在内存里」，不是一个回合状态，不报。
    default: return null;
  }
}

function validThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
}

type Socket = {
  on(event: 'message' | 'open' | 'error' | 'close', listener: (...args: never[]) => void): void;
  send(data: string): void;
  close(): void;
  terminate?(): void;
};

/**
 * 连上一条私有 app-server socket，把线程状态变化交给 `onEvent`。
 *
 * **只读**：initialize 之后不再发任何请求。现有的 `codex-control.ts` 刻意回避
 * `thread/start`、`thread/resume`、`turn/start`、`turn/steer`，这里延续同一条线——
 * 实测 resume 对 live thread 无害，但既然广播已经够用，就没有理由去碰用户正在用的会话。
 */
export function observeCodexThread(options: {
  socketPath: string;
  onEvent(event: { event: string; threadId: string }): void;
  onClosed?(): void;
  /** 注入点：测试用替身，生产走真的 unix socket。 */
  open?: (socketPath: string) => Socket;
}): { close(): void } {
  const { socketPath, onEvent, onClosed } = options;
  let closed = false;
  let last = '';
  const socket = (options.open ?? defaultOpen)(socketPath);
  const finish = () => { if (!closed) { closed = true; onClosed?.(); } };
  socket.on('error', (() => { /* 观察者坏掉不该影响终端本身，安静收场。 */ }) as never);
  socket.on('close', (() => finish()) as never);
  socket.on('open', (() => {
    socket.send(JSON.stringify({ id: 1, method: 'initialize',
      params: { clientInfo: { name: 'roost', version: '1' }, capabilities: { experimentalApi: true } } }));
    socket.send(JSON.stringify({ method: 'initialized' }));
  }) as never);
  socket.on('message', ((frame: { toString(): string }) => {
    if (closed) return;
    const text = frame.toString();
    // 单帧上限：app-server 是本机进程，正常帧都很小，超了说明不是我们认识的东西。
    if (text.length > 1048576) return;
    let row: unknown;
    try { row = JSON.parse(text); } catch { return; }
    const event = codexAgentEvent(row);
    if (!event) return;
    /*
      **同一个状态不重复报。**

      `thread/status/changed` 在一个回合里会反复发同一个 active，而下游
      （`agentStateFor` → 侧边栏 → 通知）把每一条都当成一次新观测，`since` 会被
      不停刷新，「安静了多久」就永远归零。
    */
    const key = `${event.threadId}:${event.event}`;
    if (key === last) return;
    last = key;
    onEvent(event);
  }) as never);
  return { close() { if (closed) return; closed = true; try { socket.terminate?.() ?? socket.close(); } catch { /* 已经没了。 */ } } };
}

function defaultOpen(socketPath: string): Socket {
  return new WebSocket('ws://localhost/', {
    createConnection: () => connect(socketPath),
    maxPayload: 1 << 20,
    handshakeTimeout: 5000,
    perMessageDeflate: false,
  }) as unknown as Socket;
}
