import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers/fake-pty.ts';
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');
const { createBackendServer } = await import('../src/server.ts');

/*
  `/api/fs/tree` 一次返回整棵子树，是快速切换搜文件的数据源。

  它必须走和其它文件接口同一道归属闸门（root 必须是某个终端当前的工作目录）。
  **漏掉那一行不会有任何症状**——功能照常，只是多了一个能遍历任意目录的接口。
  所以这条测试盯的是拒绝，而不是成功。
*/
async function serve(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-tree-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'work');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'top.ts'), 'x');
  writeFileSync(join(root, 'src', 'nested.ts'), 'x');

  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: root, shell: '/bin/sh', env: {}, historyStore: store });
  t.after(() => runtime.dispose());
  store.upsertSession({ id: 'web', cwd: root });

  const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  return { origin, root, outside: dir };
}

test('允许的根目录：一次请求拿到整棵子树', async (t) => {
  const { origin, root } = await serve(t);
  const response = await fetch(`${origin}/api/fs/tree?root=${encodeURIComponent(root)}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { files: { path: string }[]; truncated: boolean };
  assert.deepEqual(body.files.map(f => f.path).sort(), ['src/nested.ts', 'top.ts']);
  assert.equal(body.truncated, false);
});

test('不是任何终端工作目录的根，一律拒绝', async (t) => {
  const { origin, outside } = await serve(t);
  // outside 是 root 的父目录：真实存在、可读，但没有终端在那儿
  const response = await fetch(`${origin}/api/fs/tree?root=${encodeURIComponent(outside)}`);
  assert.equal(response.status, 403, '闸门必须挡住它，否则这就是个任意目录遍历接口');
});

test('缺少 root 时报 400，而不是当成某个默认目录', async (t) => {
  const { origin } = await serve(t);
  assert.equal((await fetch(`${origin}/api/fs/tree`)).status, 400);
});
