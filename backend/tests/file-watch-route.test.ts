import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

/**
 * 等一个事件，超时就明确失败。
 *
 * 裸的 `once()` 在这里是陷阱：只要服务端没按预期动作，测试就会永远挂着，
 * 在并发跑整套时表现为整个套件卡死而不是报错——那比失败还难查。
 */
async function waitFor(emitter: WebSocket, event: string, what: string, ms = 8000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(emitter, event),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待 ${what} 超时（${ms}ms）`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-watch-route-'));
  const workdir = mkdtempSync(join(tmpdir(), 'roost-watch-cwd-'));
  const store = createWorkspaceStore({ dataDir: dir });
  store.upsertSession({ id: 's1', cwd: workdir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  // 由夹具统一收连接，不依赖 t.after 的注册顺序：还开着的 socket 会让
  // server.close() 的回调永远不触发，测试就卡死在清理里。
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose(); store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });
  const open = (root: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/files/watch?root=${encodeURIComponent(root)}`);
    // 这条流平时不说话，握手失败也会走 error；两种都不能让进程留着句柄。
    ws.on('error', () => {});
    sockets.push(ws);
    return ws;
  };
  return { workdir, open };
}

test('订阅会话所在目录能收到变更推送，且这条流是只读的', async t => {
  const f = await fixture(t);
  const ws = f.open(f.workdir);
  await waitFor(ws, 'open', '连接建立');
  const frames: Record<string, unknown>[] = [];
  ws.on('message', data => frames.push(JSON.parse(String(data))));

  // macOS 的 FSEvents 在开始监听之后有一段布防延迟，紧跟着的第一次写入可能根本
  // 不会被投递。所以反复改动直到被观测到，而不是写一次赌它到——这是测试的问题，
  // 真实用法里监听是长期存在的，不存在这个竞争。
  const deadline = Date.now() + 15000;
  for (let attempt = 0; frames.length === 0 && Date.now() < deadline; attempt++) {
    writeFileSync(join(f.workdir, `made-by-the-agent-${attempt}.ts`), 'export {}');
    for (let i = 0; i < 20 && frames.length === 0; i++) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(frames[0]?.type, 'files-changed', '写入文件后必须收到变更帧');
  assert.equal(frames[0]?.root, f.workdir);

  // 和 session-status 一样：客户端没有任何需要告诉我们的事。
  ws.send('anything');
  const [code] = await waitFor(ws, 'close', '只读流关闭客户端');
  assert.equal(code, 1008);
});

test('不属于任何会话的目录不予监听', async t => {
  const f = await fixture(t);
  const stray = mkdtempSync(join(tmpdir(), 'roost-watch-stray-'));
  t.after(() => rmSync(stray, { recursive: true, force: true }));
  for (const root of [stray, '/etc', '']) {
    const ws = f.open(root);
    // 升级前就被拒的连接在客户端表现为握手失败。
    const [error] = await waitFor(ws, 'error', `拒绝 ${root || '(空 root)'}`);
    assert.ok(error, `${root || '(空)'} 不该被接受`);
  }
});
