import { createConnection } from 'node:net';
import type { ReplayFrame } from '@roost/terminal-protocol';
import { read, send } from './wire.ts';

/**
 * A running old owner cannot budget its reply. Request its usually much smaller
 * full screen on a separate IPC connection so an oversized reply cannot take
 * down the gateway's shared event/input channel or other viewers.
 */
export function readLegacyReplay(socketPath: string, id: string, instanceId: string | undefined,
  ownerPid: number, signal: AbortSignal): Promise<ReplayFrame | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false, requested = false;
    const unavailable = () => Object.assign(new Error('terminal replay unavailable from legacy owner'),
      {code: 'legacy_replay_unavailable', status: 503});
    const finish = (error?: Error, result?: ReplayFrame | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      socket.destroy();
      if (error) reject(error); else resolve(result ?? null);
    };
    const aborted = () => finish(unavailable());
    const timer = setTimeout(aborted, 10_000);
    signal.addEventListener('abort', aborted, {once: true});
    socket.once('error', aborted);
    socket.once('close', aborted);
    read(socket, message => {
      if (message.type === 'hello' && !requested) {
        if (message.version !== 1 || message.pid !== ownerPid || !Array.isArray(message.sessions)) {
          finish(unavailable()); return;
        }
        const session = message.sessions.find((value: {id?: string}) => value.id === id);
        if (!session) { finish(undefined, null); return; }
        if (!instanceId || session.instanceId !== instanceId) { finish(unavailable()); return; }
        requested = true;
        // Never send the old browser cursor to an unbounded owner.
        send(socket, {requestId: 1, method: 'resume', args: [id]});
      } else if (message.type === 'reply' && message.requestId === 1 && requested) {
        if (message.error) finish(Object.assign(new Error(message.error), {code: message.code, status: message.status}));
        else finish(undefined, message.result);
      }
    });
    if (signal.aborted) aborted();
  });
}
