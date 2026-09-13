import type { AgentReplay } from "@roost/terminal-protocol";
import { spawn, type IPty, type IDisposable } from "node-pty";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { shellArgs } from './shell';
export { defaultShell } from './shell';
import type { CliId, CliDefinition } from "@roost/cli-adapters";
import type { ServerMessage, ReplayCursor, AgentEvent } from "@roost/terminal-protocol";
import { createAgentEventScanner, CLI_AGENT_PROTOCOL_VERSION,
  CLI_AGENT_PROTOCOL_VERSION_ENV, CLI_AGENT_CLIENT_VERSION_ENV } from "@roost/terminal-protocol";
import { createReplayStore, type ReplayStorage } from "./replay";
import { createScreenStore } from "./screen";
import { batchCwds, cliForPid, pidCwdLinux, processTable } from "./processes";

export type { ReplayStorage } from "./replay";
export { ReplayTooLargeError } from "./replay";
export type TerminalEvent = Extract<ServerMessage, { type: "output" | "exit" | "cwd" }>
  | { type: "command-status"; command: import("@roost/terminal-protocol").AiCommand }
  | { type: "cli"; cli: CliId | null }
  | { type: "agent"; agent: AgentEvent; terminalInstanceId?: string; sourceSeq?: number };
export type TerminalSession = Readonly<{
  id: string;
  cwd: string;
  cli: CliId | null;
  pid: number;
  instanceId: string;
  /*
    PTY**现在**的尺寸。

    多个观众共用一个 PTY，最后一个改尺寸的说了算——而其它观众不知道自己被改了。
    客户端的去重比的是「我上次发了什么」，于是一个 144 列的标签页在 PTY 被另一个
    169 列的观众改掉之后，会认为「我早就发过 144 了」而永不纠正，整屏按错误宽度折断。
    [实测] 本机四个会话全是 51×169，而浏览器是 49×144。
  */
  cols: number;
  rows: number;
}>;
export type TerminalRuntimeOptions = {
  defaultCwd: string;
  shell: string;
  env: Record<string, string | undefined>;
  /** 随协议握手一起告知 agent 的宿主版本标识。 */
  clientVersion?: string;
  /** Owner-provided per-instance integration credentials; never sent to clients. */
  sessionEnv?: (id: string, instanceId: string) => Record<string, string>;
  historyStore: ReplayStorage;
  cliDefinitions?: () => readonly CliDefinition[];
  /**
   * 服务端是否持有解析好的屏幕（默认持有）。
   *
   * 关掉它，重连就退回「把原始历史发回去、让浏览器重跑一遍折叠」的老路。留这个开关有
   * 两个用处：新路万一在真机上出问题有地方退；以及**专门守老路的那些测试必须跑在老路上**
   * ——网格优先之后，那些不变式（迟到的快照不能吞掉已发出的输出、伪造的快照不能毒到别人）
   * 在新路下根本不会被触及，测试会因为「测不到」而变绿，那比红了还糟。
   */
  serverScreen?: boolean;
};
type LiveSession = {
  id: string;
  cwd: string;
  cli: CliId | null;
  pty: IPty;
  instanceId: string;
  subscriptions: IDisposable[];
};

function isDirectory(path: string) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Creates an isolated terminal owner. No server, process, scan or timer starts here. */
export function createTerminalRuntime(options: TerminalRuntimeOptions) {
  // 屏幕先建：replay 要靠它回答「现在长什么样」。
  const screen = createScreenStore();
  const replay = createReplayStore(options.historyStore, options.serverScreen === false ? undefined : screen);
  const live = new Map<string, LiveSession>();
  const listeners = new Map<string, Set<(event: TerminalEvent) => void>>();
  // 告知 CLI agent「本宿主认这套结构化事件协议」。agent 检测到才发，
  // 所以不注入就完全拿不到状态——这不是可选的优化。
  const env: Record<string, string | undefined> = {
    ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor",
    [CLI_AGENT_PROTOCOL_VERSION_ENV]: String(CLI_AGENT_PROTOCOL_VERSION),
    [CLI_AGENT_CLIENT_VERSION_ENV]: options.clientVersion ?? "roost-ai-coding-web",
  };
  // The gateway may run under automation with NO_COLOR set for its own logs.
  // A browser PTY is an interactive color terminal, not that automation output.
  delete env.NO_COLOR;
  let disposed = false;
  let scanning = false;
  const scanAbort = new AbortController();

  function resolveCwd(cwd?: string) {
    const fallback = isDirectory(options.defaultCwd) ? options.defaultCwd : homedir();
    if (!cwd) return fallback;
    const expanded = cwd === "~" ? homedir() : cwd.replace(/^~[\\/]/, `${homedir()}/`);
    return isDirectory(expanded) ? expanded : fallback;
  }

  function view(session: LiveSession): TerminalSession {
    return Object.freeze({
      id: session.id, cwd: session.cwd, cli: session.cli,
      pid: session.pty.pid, instanceId: session.instanceId,
      cols: session.pty.cols, rows: session.pty.rows,
    });
  }

  function getSession(id: string) {
    const session = live.get(id);
    return session ? view(session) : undefined;
  }

  function emit(id: string, event: TerminalEvent) {
    const subscribers = listeners.get(id);
    if (!subscribers) return;
    for (const listener of [...subscribers]) {
      try { listener(event); } catch { subscribers.delete(listener); }
    }
  }

  function clearPtyListeners(session: LiveSession) {
    for (const subscription of session.subscriptions) {
      try { subscription.dispose(); } catch { console.error("terminal listener cleanup failed", { sessionId: session.id }); }
    }
    session.subscriptions.length = 0;
  }

  /*
    起这条命令要经过登录 shell，而不是直接 exec 它。

    `claude`、`codex` 这些几乎都装在 nvm、homebrew、~/.local/bin 底下，那些路径**只有**
    跑过用户的 profile 才在 PATH 上；`-i` 是为了连 .zshrc 一起读（很多人的 nvm 就写在
    那儿）。直接 spawn("claude", …) 在开发机上能跑，到别人机器上就是 ENOENT。

    argv 一个字都不进 shell 的语法：命令行是写死的字面量，参数按位置传给 `"$@"`。
    所以「参数里有空格、引号、分号」这件事根本不存在——不是转义得好，是没有可转义的地方。
    $0 借来放 shell 自己的路径，命令结束后 `exec "$0" -l` 把交互 shell 还给用户：恢复
    失败时看到的是一条错误加一个能用的提示符，而不是一个自己关掉的终端。
  */
  function ensureSession(id: string, cwd: string, command?: readonly string[]): TerminalSession {
    if (disposed) throw new Error("Terminal runtime disposed");
    const existing = live.get(id);
    if (existing) return view(existing);
    const resolved = resolveCwd(cwd);
    replay.hydrate(id);
    let pty: IPty;
    try {
      pty = spawn(options.shell, shellArgs(options.shell, command), {
        name: "xterm-256color", cols: 80, rows: 24, cwd: resolved, env: { ...env, ...options.sessionEnv?.(id, replay.getInstanceId(id)!) },
      });
    } catch (error) {
      replay.detach(id);
      throw error;
    }
    const session: LiveSession = {
      id, cwd: pidCwdLinux(pty.pid) ?? resolved, cli: null,
      pty, instanceId: replay.getInstanceId(id)!, subscriptions: [],
    };
    live.set(id, session);
    const agentScanner = createAgentEventScanner();
    let cwdPending = '';
    session.subscriptions.push(pty.onData((data) => {
      if (disposed || live.get(id) !== session) return;
      if (process.platform === 'win32') {
        // Windows has no supported process-CWD API. Our PowerShell prompt emits OSC 7.
        cwdPending = (cwdPending + data).slice(-16384);
        for (const match of cwdPending.matchAll(/\x1b\]7;(file:[^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
          try {
            const cwd = fileURLToPath(match[1]);
            if (isDirectory(cwd) && cwd !== session.cwd) { session.cwd = cwd; emit(id, { type: 'cwd', cwd }); }
          } catch { /* Ignore malformed or non-local terminal sequences. */ }
        }
        const last = cwdPending.lastIndexOf('\x1b]7;');
        cwdPending = last >= 0 && !/[\x07]/.test(cwdPending.slice(last)) ? cwdPending.slice(last) : '';
      }
      // 先扫再落盘：事件即使在没有浏览器连接时也要被观测到——
      // 「你走开了」恰恰是这个信号最有价值的时刻。
      for (const agent of agentScanner.push(data)) emit(id, { type: "agent", agent, terminalInstanceId: session.instanceId });
      const output = replay.append(id, data);
      if (!output) return;
      // 折叠就地跑一次。同一份数据同时进服务端网格和订阅者，顺序一致。
      screen.write(id, session.instanceId, output.data, output.seq, pty.cols, pty.rows);
      emit(id, { type: "output", ...output });
    }));
    session.subscriptions.push(pty.onExit(() => {
      if (disposed || live.get(id) !== session) return;
      live.delete(id);
      clearPtyListeners(session);
      replay.detach(id);
      emit(id, { type: "exit" });
    }));
    return view(session);
  }

  function subscribe(id: string, listener: (event: TerminalEvent) => void) {
    if (disposed) return () => {};
    const subscribers = listeners.get(id) ?? new Set();
    subscribers.add(listener);
    listeners.set(id, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size && listeners.get(id) === subscribers) listeners.delete(id);
    };
  }

  function writeSession(id: string, data: string) {
    live.get(id)?.pty.write(data);
  }

  function resizeSession(id: string, cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1
      || cols > 1000 || rows > 1000) return;
    live.get(id)?.pty.resize(cols, rows);
    screen.resize(id, cols, rows);
  }

  function killSession(id: string) {
    if (disposed) return false;
    const session = live.get(id);
    screen.drop(id);
    try { replay.drop(id); } finally {
      if (session) {
        live.delete(id);
        clearPtyListeners(session);
        try { session.pty.kill(); } catch { /* Already exited. */ }
        emit(id, { type: "exit" });
        listeners.delete(id);
      }
    }
    if (!session) return false;
    return true;
  }

  async function scanLiveSessions() {
    if (disposed || scanning || !live.size) return;
    scanning = true;
    try {
      const sessions = [...live.values()];
      const [cwds, table] = await Promise.all([
        batchCwds(sessions.map((session) => session.pty.pid), scanAbort.signal), processTable(scanAbort.signal),
      ]);
      if (disposed) return;
      const definitions = options.cliDefinitions?.();
      for (const session of sessions) {
        if (live.get(session.id) !== session) continue;
        const cwd = cwds.get(session.pty.pid);
        if (cwd && cwd !== session.cwd) {
          session.cwd = cwd;
          emit(session.id, { type: "cwd", cwd });
        }
        const cli = cliForPid(session.pty.pid, table, definitions);
        if (cli !== session.cli) {
          session.cli = cli;
          emit(session.id, { type: "cli", cli });
        }
      }
    } finally { scanning = false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      replay.dispose();
      screen.dispose();
    } finally {
      scanAbort.abort();
      for (const session of live.values()) {
        clearPtyListeners(session);
        try { session.pty.kill(); } catch { /* Already exited. */ }
      }
      live.clear();
      listeners.clear();
    }
  }

  return {
    resolveCwd, ensureSession, getSession, writeSession, resizeSession,
    killSession, subscribe, scanLiveSessions, dispose,
    resume: (id: string, cursor?: ReplayCursor, maxBytes?: number) => replay.resume(id, cursor, maxBytes),
    setSnapshot: (id: string, data: string, instanceId: string, seq: number) =>
      replay.setSnapshot(id, data, instanceId, seq),
    flush: (id: string) => replay.flush(id),
  };
}

export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

/** A daemon-verified observation; callers must still pin the terminal instance on use. */
export type ConversationRuntime = {
  conversationId: string; runId: string; webSessionId: string;
  terminalInstanceId: string; generation: string; cliId: string;
  nativeSessionId: string; runtimeVerified: true;
};

/** Gateway-facing operations may cross a process boundary. */
export type TerminalService = Omit<TerminalRuntime, 'ensureSession'|'killSession'|'resume'|'flush'|'setSnapshot'> & {
  resolveConversationRuntime?: (conversationId: string) => Promise<ConversationRuntime>;
  resolveTerminalConversation?: (terminalId: string) => Promise<ConversationRuntime>;
  ensureSession: (...args:Parameters<TerminalRuntime['ensureSession']>) => TerminalSession | Promise<TerminalSession>;
  killSession: (id:string) => boolean | Promise<boolean>;
  resume: (...args:Parameters<TerminalRuntime['resume']>) => ReturnType<TerminalRuntime['resume']> | Promise<ReturnType<TerminalRuntime['resume']>>;
  flush: (id:string) => boolean | Promise<boolean>;
  setSnapshot: (...args:Parameters<TerminalRuntime['setSnapshot']>) => boolean | void;
  commandSendingState?:()=>Promise<{configured:boolean;enabled:boolean}>;
  setCommandSendingEnabled?:(enabled:boolean)=>Promise<{configured:boolean;enabled:boolean}>;
  commandControl?: (id:string)=>Promise<import('@roost/terminal-protocol').AiControl>;
  enqueueCommand?: (id:string,input:import('@roost/terminal-protocol').AiCommandInput)=>Promise<import('@roost/terminal-protocol').AiCommand>;
  cancelCommand?: (id:string,requestId:string)=>Promise<import('@roost/terminal-protocol').AiCommand>;
  writeProtocolResponse?: (id:string,data:string)=>void;
  ownerPid?: number;
  listSessions?: () => TerminalSession[];
  isConnected?: () => boolean;
  supportsAgentReplay?: () => boolean;
  readAgentEvents?: (id: string, instance: string, after: number) => Promise<AgentReplay>;
  onDisconnect?: (listener:()=>void)=>()=>void;
};
