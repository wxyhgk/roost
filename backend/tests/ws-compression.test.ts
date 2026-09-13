import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

/*
  终端流必须是压缩的。

  Caddy 的 `encode zstd gzip` **对 upgrade 之后的连接不生效**，所以这条流要么在
  WebSocket 这一层压，要么就是端到端明文。它恰好是压缩比最高的那种数据：JSON 包封
  套着 ANSI 转义，每帧还把同一个 instanceId（36 字节的 UUID）重发一遍。

  这条测试守的是「协商确实发生了」这个事实本身——`perMessageDeflate` 漏配不会报错、
  不会断连、功能一切正常，只是字节悄悄变成十倍。没有测试的话，这种回归没人会发现。
*/
test('websocket upgrades negotiate permessage-deflate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ws-deflate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: '/bin/sh', env: {}, historyStore: store });
  t.after(() => runtime.dispose());

  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/session-status`, { perMessageDeflate: true });
  t.after(() => socket.close());
  await once(socket, 'open');

  assert.ok(
    socket.extensions.includes('permessage-deflate'),
    `服务端没有协商压缩，实际扩展：${socket.extensions || '(无)'}`,
  );
});
