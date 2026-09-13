import type {AgentEvent} from '@roost/terminal-protocol';
import { OPENCODE_OBSERVATION_PROTOCOL_VERSION } from './opencode-protocol.ts';

/** Metadata from a terminal-scoped TUI observer, never from the latest server session. */
export function parseOpenCodeObservation(input: unknown): AgentEvent {
  const value = input as Record<string, unknown> | null;
  const events: Record<string, string> = {SessionStart:'session_start',UserPromptSubmit:'prompt_submit',Stop:'stop',PermissionRequest:'permission_request',SessionEnd:'session_end'};
  if (!value || typeof value.event !== 'string' || !Object.hasOwn(events,value.event) ||
      typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value.sessionId) ||
      // Legacy observers have the same payload without protocolVersion.
      (value.protocolVersion !== undefined && value.protocolVersion !== OPENCODE_OBSERVATION_PROTOCOL_VERSION) ||
      typeof value.transcriptPath !== 'string' || value.transcriptPath.length > 4096)
    throw new Error('invalid OpenCode observation');
  let endpoint: URL;
  try { endpoint = new URL(value.transcriptPath); } catch { throw new Error('invalid OpenCode endpoint'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname !== '/' ||
      [...endpoint.searchParams.keys()].some(key=>key!=='directory') || endpoint.searchParams.getAll('directory').length > 1)
    throw new Error('invalid OpenCode endpoint');
  return {event:events[value.event],agent:'opencode',sessionId:value.sessionId,transcriptPath:endpoint.toString()};
}
