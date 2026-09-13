export type Activity = 'active' | 'quiet' | 'exited' | 'closed' | 'unavailable';
/**
 * agent 自报的状态，与 Activity 正交：agent 在等你批准（blocked）时，
 * PTY 恰恰是安静的（quiet）。两者必须能同时表达。
 */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'failed';
export type SessionAgent = { state: AgentState; name: string | null; agentSessionId: string | null; since: number; waitingFor: 'permission' | 'question' | null;
  /** 只在 blocked 期间有值：拦住你的那件事的整句描述、工具名、以及入参里可展示的那一项。 */
  summary: string | null; toolName: string | null; toolInputPreview: string | null };
export type StatusEntry = { id: string; instanceId: string | null; cliId: string | null; state: Activity; lastOutputAt: number | null; outputSeq: number | null; agent: SessionAgent | null };
export type StatusFrame = { type: 'session-status'; monitorId: string; revision: number; quietAfterMs: number; sessions: StatusEntry[] };
type Cursor = { monitorId: string; instanceId: string | null; outputSeq: number };
export type ActivityView = { state: Activity | 'connecting' | 'disconnected' | 'unknown'; unread: boolean; cliId: string | null;
  /** 当前连着的终端实例。同一个会话 ID 换了一条 shell 时它会变——「跟随」要靠它识别位置是否已失效。 */
  instanceId: string | null;
  lastOutputAt: number | null; agent: SessionAgent | null };
const initial: ActivityView = { state: 'connecting', unread: false, cliId: null, instanceId: null, lastOutputAt: null, agent: null };
const disconnected: ActivityView = { ...initial, state: 'disconnected' };
const unknown: ActivityView = { ...initial, state: 'unknown' };
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** 老后端不发这个字段，按「没有 agent」处理，不能因此把整帧判为无效。 */
/** 只比对会影响显示的字段：since 每次事件都变，拿它比会让每帧都重渲染。 */
function sameAgent(a: SessionAgent | null, b: SessionAgent | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && a.waitingFor === b.waitingFor && a.name === b.name && a.agentSessionId === b.agentSessionId && a.since === b.since
    && a.summary === b.summary && a.toolName === b.toolName && a.toolInputPreview === b.toolInputPreview;
}
const optionalText = (value: unknown) => value === null || value === undefined || typeof value === 'string';
function validAgent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  const a = value as SessionAgent;
  return ['idle', 'working', 'blocked', 'done', 'failed'].includes(a.state)
    && (a.name === null || typeof a.name === 'string')
    && (a.agentSessionId === null || typeof a.agentSessionId === 'string')
    && seq(a.since)
    && (a.waitingFor === null || a.waitingFor === 'permission' || a.waitingFor === 'question')
    // 这三项是后加的：老后端根本不发，缺省必须当合法，否则一升级前端就整帧作废。
    && optionalText(a.summary) && optionalText(a.toolName) && optionalText(a.toolInputPreview);
}

export function parseStatusFrame(value: unknown): StatusFrame | null {
  if (!value || typeof value !== 'object') return null;
  const f = value as StatusFrame;
  if (f.type !== 'session-status' || typeof f.monitorId !== 'string' || !f.monitorId || !seq(f.revision) || !seq(f.quietAfterMs) || !Array.isArray(f.sessions)) return null;
  const ids = new Set<string>();
  for (const s of f.sessions) {
    if (!s || typeof s.id !== 'string' || ids.has(s.id) ||
      !(s.instanceId === null || typeof s.instanceId === 'string') || !(s.cliId === null || typeof s.cliId === 'string') ||
      !['active', 'quiet', 'exited', 'closed', 'unavailable'].includes(s.state) ||
      !(s.outputSeq === null || seq(s.outputSeq)) || !(s.lastOutputAt === null || seq(s.lastOutputAt)) ||
      !validAgent(s.agent)) return null;
    ids.add(s.id);
  }
  return f;
}

export function createSessionStatusStore(saved: unknown = null, onReadChanged: () => void = () => {}) {
  let monitorId = '', revision = -1, health: 'connecting' | 'connected' | 'disconnected' = 'connecting';
  let entries = new Map<string, StatusEntry>();
  const cursors = new Map<string, Cursor>();
  const earlyPresented = new Map<string, { instanceId: string; outputSeq: number }>();
  const views = new Map<string, ActivityView>();
  const listeners = new Map<string, Set<() => void>>();
  if (Array.isArray(saved)) for (const pair of saved.slice(-1000)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [id, c] = pair;
    if (typeof id === 'string' && c && typeof c.monitorId === 'string' &&
      (c.instanceId === null || typeof c.instanceId === 'string') && seq(c.outputSeq)) cursors.set(id, c);
  }
  function publish() {
    for (const id of new Set([...entries.keys(), ...views.keys(), ...listeners.keys()])) {
      const entry = entries.get(id), cursor = cursors.get(id);
      const next: ActivityView = entry ? {
        state: health === 'connected' ? entry.state : health,
        unread: !!cursor && cursor.monitorId === monitorId && cursor.instanceId === entry.instanceId && entry.outputSeq !== null && entry.outputSeq > cursor.outputSeq,
        cliId: entry.cliId, instanceId: entry.instanceId, lastOutputAt: entry.lastOutputAt, agent: entry.agent ?? null,
      } : health === 'connected' ? unknown : health === 'disconnected' ? disconnected : initial;
      const prev = views.get(id);
      if (prev && prev.state === next.state && prev.unread === next.unread && prev.cliId === next.cliId && prev.instanceId === next.instanceId
        && prev.lastOutputAt === next.lastOutputAt && sameAgent(prev.agent, next.agent)) continue;
      views.set(id, next);
      listeners.get(id)?.forEach(fn => fn());
    }
  }
  return {
    read: (id: string) => views.get(id) ?? (health === 'connected' ? unknown : health === 'disconnected' ? disconnected : initial),
    subscribe(id: string, fn: () => void) {
      const group = listeners.get(id) ?? new Set(); group.add(fn); listeners.set(id, group);
      return () => { group.delete(fn); if (!group.size) listeners.delete(id); };
    },
    accept(value: unknown): boolean {
      const frame = parseStatusFrame(value);
      if (!frame || (frame.monitorId === monitorId && frame.revision < revision)) return false;
      const changed = frame.monitorId !== monitorId || frame.revision !== revision;
      health = 'connected';
      if (changed) {
        monitorId = frame.monitorId; revision = frame.revision;
        entries = new Map(frame.sessions.map(s => [s.id, s]));
        let dirty = false;
        for (const s of frame.sessions) {
          const old = cursors.get(s.id);
          if (!old || old.monitorId !== monitorId || old.instanceId !== s.instanceId) {
            cursors.set(s.id, { monitorId, instanceId: s.instanceId, outputSeq: s.outputSeq ?? 0 }); dirty = true;
          }
          const shown = earlyPresented.get(s.id), cursor = cursors.get(s.id)!;
          if (shown?.instanceId === s.instanceId && shown.outputSeq > cursor.outputSeq) {
            cursors.set(s.id, { ...cursor, outputSeq: shown.outputSeq }); dirty = true;
          }
          earlyPresented.delete(s.id);
        }
        for (const id of cursors.keys()) if (!entries.has(id)) { cursors.delete(id); dirty = true; }
        if (dirty) onReadChanged();
      }
      publish(); return true;
    },
    disconnect() { health = 'disconnected'; publish(); },
    presented(id: string, instanceId: string, outputSeq: number) {
      if (!seq(outputSeq)) return;
      // PTY replay can finish before the independent status feed's first frame.
      // Preserve that real render, so the next status tick cannot mark it unread.
      if (health === 'connecting') {
        const old = earlyPresented.get(id);
        earlyPresented.set(id, { instanceId, outputSeq: old?.instanceId === instanceId ? Math.max(old.outputSeq, outputSeq) : outputSeq });
        return;
      }
      const entry = entries.get(id), old = cursors.get(id);
      if (health !== 'connected' || entry?.instanceId !== instanceId || !old || old.monitorId !== monitorId || old.instanceId !== instanceId || outputSeq <= old.outputSeq) return;
      // The rendered cursor may be ahead of the next status snapshot.
      cursors.set(id, { monitorId, instanceId, outputSeq }); onReadChanged(); publish();
    },
    serialize: () => [...cursors].slice(-1000),
  };
}
