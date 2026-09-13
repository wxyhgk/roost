import { createSessionStatusStore } from './store';
import { connectSessionStatus } from './connection';
import { stableRuntime } from '../../shared/runtime';

const KEY = 'roost-session-read-v1';
let timer: ReturnType<typeof setTimeout> | undefined;
function load() { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } }
function flush() { clearTimeout(timer); timer = undefined; try { localStorage.setItem(KEY, JSON.stringify(sessionStatus.serialize())); } catch { /* Read markers remain usable in memory. */ } }
export const sessionStatus = createSessionStatusStore(load(), () => { if (!timer) timer = setTimeout(flush, 500); });
let users = 0, stop: (() => void) | undefined;
export function startSessionStatus() {
  if (++users === 1) {
    // This optional business feed does not exist on the stable core API.
    const url = new URL('/api/session-status', stableRuntime ? 'http://127.0.0.1:8787' : window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    stop = connectSessionStatus(url.toString(), sessionStatus);
    window.addEventListener('pagehide', flush);
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--users === 0) { stop?.(); stop = undefined; window.removeEventListener('pagehide', flush); flush(); }
  };
}
