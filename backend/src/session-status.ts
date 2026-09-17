import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { WorkspaceStore } from '@roost/workspace-store';
import type { TerminalService } from '@roost/terminal-runtime';
import { QUIET_STATE_AFTER_MS, type AgentTask } from '@roost/terminal-protocol';

/**
 * agent 自报的状态。与 SessionActivity.state 正交——后者描述 PTY 有没有在出字节，
 * 前者描述 agent 在干什么。两者可以同时成立：agent 弹了确认框在等你（blocked）时，
 * PTY 恰恰是安静的（quiet）。把它们并进一个枚举会同时毁掉两边的语义。
 */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'failed';
export type SessionAgent = {
  state: AgentState;
  /** agent 自称的名字，如 omp / claude。 */
  name: string | null;
  /** agent 自己的会话 id，与我们的 session id 无关。 */
  agentSessionId: string | null;
  /** 进入当前状态的时刻。 */
  since: number;
  /** blocked 时等的是什么，用于区分「要你批准」和「要你回答」。 */
  waitingFor: 'permission' | 'question' | null;
  /**
   * 以下三项只在 blocked 期间有值，离开 blocked 必须一起清空。
   * 它们描述的是「此刻拦住你的那一件事」，一旦放行就不再成立；留着会让权限摘要
   * 泄漏到后续的会话行与通知里，显示成一件早就批准完的事还在等你。
   */
  summary: string | null;
  toolName: string | null;
  toolInputPreview: string | null;
  /**
   * agent 自己维护的任务清单，**和 state 正交**。
   *
   * 它跨状态存活：一轮跑完（done）之后那份清单依然是这一轮做了什么的说明，清掉就等于
   * 「跑完了就看不见做过什么」。只有新会话（session_start）才重新开始。
   */
  tasks: AgentTask[] | null;
};

export type SessionActivity = {
  id: string;
  instanceId: string | null;
  cliId: string | null;
  state: 'active' | 'quiet' | 'exited' | 'closed' | 'unavailable';
  lastOutputAt: number | null;
  outputSeq: number | null;
  agent: SessionAgent | null;
};
type Observation = { instanceId: string; lastOutputAt: number; outputSeq: number };

/**
 * 事件 → 状态。返回 null 表示这条事件不改变状态。
 *
 * 有两类事件不能无条件改状态，因为它们会在「这一轮已经结束」之后迟到：
 *
 * - idle_prompt：agent 收工回到提示符也会发它，据此改状态会把已经到达的 stop
 *   覆盖成「空闲」，让「跑完了」这个信息凭空消失。故一律忽略。
 * - tool_complete / permission_replied：它们只是「解除阻塞」的信号，不是「开始干活」
 *   的信号。stop 之后迟到一条 tool_complete，会把已经到达的 done 翻回 working，
 *   看起来像任务自己又跑起来了。故仅当此刻确实卡在 blocked 时才放行。
 */
function agentStateFor(
  event: string,
  current: AgentState | undefined,
): { state: AgentState; waitingFor: SessionAgent['waitingFor'] } | null {
  switch (event) {
    case 'session_start': return { state: 'idle', waitingFor: null };
    case 'prompt_submit': return { state: 'working', waitingFor: null };
    case 'tool_complete':
    case 'permission_replied':
      return current === 'blocked' ? { state: 'working', waitingFor: null } : null;
    case 'permission_request': return { state: 'blocked', waitingFor: 'permission' };
    case 'question_asked': return { state: 'blocked', waitingFor: 'question' };
    case 'stop': return { state: 'done', waitingFor: null };
    case 'stop_failure': return { state: 'failed', waitingFor: null };
    default: return null;
  }
}

/** Observes PTY activity, never infers AI completion from silence or animation. */
export function createSessionStatus(store: WorkspaceStore, runtime: TerminalService, now = Date.now) {
  const monitorId = randomUUID();
  const observations = new Map<string, Observation>();
  const agents = new Map<string, SessionAgent & { instanceId: string | null }>();
  const subscriptions = new Map<string, () => void>();
  const peers = new Set<WebSocket>();
  let sessions: SessionActivity[] = [];
  let encoded = '';
  let revision = 0;
  let disposed = false;
  const quietAfterMs = QUIET_STATE_AFTER_MS;
  const snapshot = () => ({ type: 'session-status' as const, monitorId, revision, quietAfterMs, sessions });
  function send(peer: WebSocket, payload: string) {
    if (peer.readyState !== peer.OPEN) return;
    try {
      if (peer.bufferedAmount + Buffer.byteLength(payload) > 1024 * 1024) { peer.terminate(); return; }
      peer.send(payload, error => { if (error) peer.terminate(); });
    } catch { peer.terminate(); }
  }
  function refresh() {
    if (disposed) return;
    const records = store.loadWorkspace().sessions;
    const ids = new Set(records.map(record => record.id));
    for (const [id, unsubscribe] of subscriptions) {
      if (!ids.has(id)) { unsubscribe(); subscriptions.delete(id); observations.delete(id); agents.delete(id); }
    }
    for (const record of records) {
      if (subscriptions.has(record.id)) continue;
      subscriptions.set(record.id, runtime.subscribe(record.id, event => {
        if (disposed) return;
        if (event.type === 'output') {
          const previous = observations.get(record.id);
          if (previous?.instanceId === event.instanceId && previous.outputSeq >= event.seq) return;
          observations.set(record.id, { instanceId: event.instanceId, outputSeq: event.seq, lastOutputAt: now() });
        }
        if (event.type === 'agent') {
          const previous = agents.get(record.id);
          /*
            任务清单不走状态机：agent 改一次清单，既不说明它开始干活，也不说明它停了。
            所以在 agentStateFor 之前单独处理，并且**原样保留**此刻的状态。

            没有 previous 就丢掉：那说明这一条 agent 的生命周期我们从头就没看见（后端刚
            重启之类），凭一次 TodoWrite 现造一个 agent 记录是在猜它的状态。
          */
          if (event.agent.event === 'tasks_updated') {
            if (!previous || !event.agent.tasks) return;
            agents.set(record.id, { ...previous, tasks: event.agent.tasks });
            return;
          }
          const next = agentStateFor(event.agent.event, previous?.state);
          if (!next) return;
          const blocked = next.state === 'blocked';
          agents.set(record.id, {
            ...next,
            name: event.agent.agent ?? previous?.name ?? null,
            agentSessionId: event.agent.sessionId ?? null,
            since: now(),
            // 只有 blocked 才带这三项；任何离开 blocked 的转移都在这里被清成 null。
            summary: blocked ? event.agent.summary ?? null : null,
            toolName: blocked ? event.agent.toolName ?? null : null,
            toolInputPreview: blocked ? event.agent.toolInputPreview ?? null : null,
            // 换会话才重开一份清单；同一条会话里的状态流转一概保留。
            tasks: event.agent.event === 'session_start' ? null : previous?.tasks ?? null,
            instanceId: runtime.getSession(record.id)?.instanceId ?? null,
          });
        }
      }));
    }
    const connected = runtime.isConnected?.() ?? true;
    const next = records.map((record): SessionActivity => {
      const live = connected ? runtime.getSession(record.id) : undefined;
      let observation = observations.get(record.id);
      if (live && observation && observation.instanceId !== live.instanceId) {
        observations.delete(record.id); observation = undefined;
      }
      // 换了一条 shell 就换了一个 agent 进程，旧状态不该跟着新实例走。
      let agentRecord = agents.get(record.id);
      if (agentRecord && (!live || (agentRecord.instanceId !== null && agentRecord.instanceId !== live.instanceId))) {
        agents.delete(record.id); agentRecord = undefined;
      }
      const state = record.closed ? 'closed' : !connected ? 'unavailable' : !live ? 'exited'
        : observation && now() - observation.lastOutputAt < quietAfterMs ? 'active' : 'quiet';
      return { id: record.id, instanceId: live?.instanceId ?? observation?.instanceId ?? null,
        cliId: live?.cli ?? null, state, lastOutputAt: observation?.lastOutputAt ?? null, outputSeq: observation?.outputSeq ?? null,
        agent: agentRecord
          ? { state: agentRecord.state, name: agentRecord.name, agentSessionId: agentRecord.agentSessionId,
              since: agentRecord.since, waitingFor: agentRecord.waitingFor, summary: agentRecord.summary,
              toolName: agentRecord.toolName, toolInputPreview: agentRecord.toolInputPreview, tasks: agentRecord.tasks }
          : null };
    });
    const content = JSON.stringify(next);
    if (content === encoded) return;
    encoded = content; sessions = next; revision++;
    const payload = JSON.stringify(snapshot());
    for (const peer of peers) send(peer, payload);
  }
  refresh();
  let refreshFailed = false;
  let heartbeatTicks = 0;
  const timer = setInterval(() => {
    try {
      refresh(); refreshFailed = false;
      // A repeated snapshot also lets clients detect a silent network failure.
      if (++heartbeatTicks >= 60) {
        heartbeatTicks = 0;
        const payload = JSON.stringify(snapshot());
        for (const peer of peers) send(peer, payload);
      }
    } catch {
      if (!refreshFailed) console.error('session status refresh failed');
      refreshFailed = true;
      for (const peer of peers) peer.close(1011, 'status temporarily unavailable');
    }
  }, 250);
  timer.unref();
  return {
    refresh,
    snapshot() { refresh(); return snapshot(); },
    attach(peer: WebSocket) {
      refresh(); peers.add(peer);
      peer.on('close', () => peers.delete(peer));
      peer.on('error', () => { peers.delete(peer); peer.terminate(); });
      // A read-only stream: no terminal input or output history is exposed here.
      peer.on('message', () => peer.close(1008, 'read-only stream'));
      send(peer, JSON.stringify(snapshot()));
    },
    dispose() {
      disposed = true; clearInterval(timer);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear(); observations.clear(); agents.clear();
      for (const peer of peers) peer.terminate();
      peers.clear();
    },
  };
}
