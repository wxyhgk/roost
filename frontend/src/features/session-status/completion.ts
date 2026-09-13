import type { ActivityView, SessionAgent } from './store';

/** A completion is a new observed state, never an inference from output silence. */
export function createCompletionTracker() {
  const seen = new Map<string, { identity: string; state: SessionAgent['state'] }>();
  return {
    observe(id: string, view: ActivityView): boolean {
      const agent = view.agent;
      if (!['active', 'quiet'].includes(view.state) || !view.instanceId || !agent
        || (view.cliId && agent.name !== view.cliId)) {
        seen.delete(id);
        return false;
      }
      const identity = JSON.stringify([view.instanceId, view.cliId ?? agent.name, agent.agentSessionId]);
      const previous = seen.get(id);
      seen.set(id, { identity, state: agent.state });
      // Initial snapshots and a different CLI/session establish a baseline.
      // Repeated stop reports for the same completed turn stay silent.
      return previous?.identity === identity && previous.state !== 'done' && agent.state === 'done';
    },
    retain(ids: string[]) {
      const keep = new Set(ids);
      for (const id of seen.keys()) if (!keep.has(id)) seen.delete(id);
    },
  };
}
