import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { startTerminalOwner, connectTerminalDaemon } from '@roost/terminal-daemon';
import { createWorkspaceStore } from '@roost/workspace-store';
import { createBackendServer } from '../src/server.ts';

// Opt in: actual installed OpenCode, a private daemon/database/XDG directory,
// two new native sessions and shell-only messages. No model/API billing.
test('real OpenCode resumes the latest offline selection and retains both conversations',
  { skip: process.env.ROOST_VERIFY_OPENCODE_RESUME !== '1', timeout: 90000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roost-opencode-resume-'));
    const cwd = join(directory, 'work'); await mkdir(cwd);
    const previous = new Map<string, string | undefined>();
    for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      previous.set(key, process.env[key]); process.env[key] = join(directory, key);
    }
    const reservation = netServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const socketPath = join(directory, 'daemon.sock');
    const owner = await startTerminalOwner({ dataDir: directory, socketPath, shell: '/bin/zsh', defaultCwd: cwd });
    const store = createWorkspaceStore({ dataDir: directory });
    const client = await connectTerminalDaemon(socketPath);
    let server: ReturnType<typeof createBackendServer> | undefined;
    let base = '', nativeBase = `http://127.0.0.1:${port}`;
    const native = (path: string, body?: unknown, method = 'POST') => fetch(`${nativeBase}${path}?directory=${encodeURIComponent(cwd)}`,
      { method: body === undefined ? 'GET' : method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const until = async (read: () => Promise<boolean>, label: string) => {
      for (let i = 0; i < 160; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
      throw Error(label);
    };
    const openGateway = async () => {
      server = createBackendServer({ auth: false, store, runtime: client, workspaceRoot: cwd });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    };
    const closeGateway = async () => {
      if (!server) return;
      server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
    };
    try {
      store.upsertSession({ id: 'resume-live', cwd });
      const original = await client.ensureSession('resume-live', cwd);
      client.writeSession('resume-live', `opencode --port ${port}\r`);
      await until(async () => { try { return (await native('/global/health')).ok; } catch { return false; } }, 'OpenCode server unavailable');
      const ids: string[] = [];
      for (const title of ['recovery fixture A', 'recovery fixture B']) {
        const response = await native('/session', { title }); assert.equal(response.status, 200);
        ids.push((await response.json()).id);
      }
      const select = async (id: string) => { assert.equal((await native('/tui/select-session', { sessionID: id })).status, 200); };
      const observed = async (id: string, instance = original.instanceId) => {
        const page = await client.readAgentEvents!('resume-live', instance, 0);
        return page.events.some(event => event.agent.agent === 'opencode' && event.agent.sessionId === id && event.agent.event === 'session_start');
      };
      await select(ids[0]);
      await until(async () => { await select(ids[0]); return observed(ids[0]); }, 'first native identity missing');
      assert.equal((await native(`/session/${ids[0]}/shell`, { agent: 'build', command: 'printf recovery-marker-A' })).status, 200);
      await openGateway();
      await until(async () => {
        const response = await fetch(base + '/api/ai-sessions/resume-live');
        const body = await response.json();
        return body.binding?.nativeSessionId === ids[0] && body.sync?.transcript?.mode === 'transcript';
      }, 'first conversation was not synchronized');
      await until(async () => !!store.conversations.findBySource('opencode', ids[0]), 'first conversation was not saved');
      await closeGateway();
      await select(ids[1]);
      await until(() => observed(ids[1]), 'offline native switch missing');
      assert.equal((await native(`/session/${ids[1]}/shell`, { agent: 'build', command: 'printf recovery-marker-B' })).status, 200);
      await client.killSession('resume-live');
      await until(async () => !client.getSession('resume-live'), 'original PTY did not exit');
      await openGateway();
      const plan = await (await fetch(base + '/api/sessions/resume-live/resume')).json();
      assert.equal(plan.available, true); assert.equal(plan.nativeSessionId, ids[1]);
      const resumed = await fetch(base + '/api/sessions/resume-live/reopen', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resume: true }),
      });
      assert.equal(resumed.status, 200);
      await until(async () => !!client.getSession('resume-live'), 'resumed PTY missing');
      const current = client.getSession('resume-live')!;
      assert.notEqual(current.instanceId, original.instanceId);
      await until(() => observed(ids[1], current.instanceId), 'resumed TUI did not select the latest native conversation');
      const page = await client.readAgentEvents!('resume-live', current.instanceId, 0);
      const identity = page.events.find(event => event.agent.event === 'session_start' && event.agent.sessionId === ids[1])!;
      nativeBase = new URL(identity.agent.transcriptPath!).origin;
      for (let i = 0; i < ids.length; i++) {
        const transcript = await native(`/session/${ids[i]}/message`);
        assert.equal(transcript.status, 200);
        assert.ok((await transcript.text()).includes(`recovery-marker-${i === 0 ? 'A' : 'B'}`), 'native history was not retained');
        assert.ok(store.conversations.findBySource('opencode', ids[i]), 'saved conversation was lost');
      }
    } finally {
      await closeGateway(); client.dispose(); await owner.stop(); store.close();
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(directory, { recursive: true, force: true });
    }
  });
