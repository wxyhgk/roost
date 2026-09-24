import { errorText } from '@roost/i18n';
import { fetchWithSession } from '../api/session-fetch';
export type CliRule = {
  kind: 'executable' | 'script' | 'executablePathContains';
  value: string;
};
export type CliConfig = {
  id: string;
  name: string;
  command: string;
  rules: CliRule[];
  iconRef: string | null;
  iconUrl: string | null;
  builtin: boolean;
  enabled: boolean;
  priority: number;
  capabilities: { text: boolean; image: boolean };
};
export type CliConfigInput = Pick<CliConfig, 'name' | 'command' | 'rules'> &
  Partial<Pick<CliConfig, 'id' | 'iconRef' | 'enabled' | 'priority'>>;
export type CliConfigPatch = Partial<Omit<CliConfigInput, 'id'>>;
type Snapshot = { configs: CliConfig[]; loading: boolean; error: string | null };

/** Shared cache, independent of the UI so request ordering is testable. */
/*
  默认走 `fetchWithSession` 而不是裸 `fetch`。

  这个 store 是所有 `SessionLogo` 图标的来源，会话一过期它就该跟着走登录关卡；原来用裸
  `fetch`，401 不广播、也没有兜底截止时间，于是过期之后它安静地失败、请求挂住就永远停在
  加载中。参数仍然留着——测试注入自己的实现，那正是它当初被写成参数的理由。
*/
export function createCliConfigStore(request: typeof fetch = fetchWithSession) {
  let snapshot: Snapshot = { configs: [], loading: false, error: null };
  let loaded = false;
  let version = 0;
  let inFlight: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  async function api<T>(path = '', init?: RequestInit): Promise<T> {
    const response = await request(`/api/cli-configs${path}`, init);
    if (!response.ok) {
      let message = errorText(null, response.status);
      try {
        const body = await response.json();
        message = errorText(typeof body?.error?.code === 'string' ? body.error.code : null, response.status, typeof body?.error?.message === 'string' ? body.error.message : null);
      } catch { /* Preserve HTTP status if the server returned no JSON. */ }
      throw new Error(message);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    emit({ loading: true, error: null });
    inFlight = (async () => {
      try {
        // If a write overlaps a read, fetch again after the queued writes finish.
        // This also fills the rest of the list when initial loading overlaps create.
        for (;;) {
          await writes;
          const startedAt = version;
          try {
            const { configs } = await api<{ configs: CliConfig[] }>();
            if (version !== startedAt) continue;
            loaded = true;
            emit({ configs, error: null });
          } catch (error) {
            if (version !== startedAt) continue;
            emit({ error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
      } finally {
        inFlight = null;
        emit({ loading: false });
      }
    })();
    return inFlight;
  }
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize writes (including icon uploads), and invalidate GETs started before
    // or during a write. A delayed list response must never undo a saved logo.
    version++;
    const result = writes.then(async () => {
      try { return await operation(); }
      finally { version++; }
    });
    writes = result.catch(() => undefined);
    return result;
  }
  const apply = (config: CliConfig) => {
    const exists = snapshot.configs.some(item => item.id === config.id);
    emit({ configs: exists ? snapshot.configs.map(item => item.id === config.id ? config : item)
      : [...snapshot.configs, config] });
    return config;
  };
  const idPath = (id: string) => `/${encodeURIComponent(id)}`;
  const json = (method: string, body: unknown): RequestInit => ({ method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureLoaded() { return loaded ? Promise.resolve() : refresh(); },
    refresh,
    create: (input: CliConfigInput) => mutate(async () => apply(await api<CliConfig>('', json('POST', input)))),
    update: (id: string, patch: CliConfigPatch) => mutate(async () => apply(await api<CliConfig>(idPath(id), json('PATCH', patch)))),
    reset: (id: string) => mutate(async () => apply(await api<CliConfig>(`${idPath(id)}/reset`, { method: 'POST' }))),
    uploadIcon: (id: string, blob: Blob) => mutate(async () => apply(await api<CliConfig>(`${idPath(id)}/icon`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    }))),
    remove: (id: string) => mutate(async () => {
      await api<void>(idPath(id), { method: 'DELETE' });
      emit({ configs: snapshot.configs.flatMap(item => item.id !== id ? [item]
        : item.builtin ? [{ ...item, enabled: false }] : []) });
    }),
  };
}
