import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function run(dir: string, script: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks", "--input-type=module", "-e", `
    import { latestPty } from './tests/helpers/fake-pty.ts';
    const { createWorkspaceStore } = await import('@roost/workspace-store');
    const { createTerminalRuntime } = await import('@roost/terminal-runtime');
    const store = createWorkspaceStore({ dataDir: process.env.TEST_DATA_DIR });
    const runtime = createTerminalRuntime({ defaultCwd: process.env.TEST_DATA_DIR, shell: '/bin/zsh', env: {}, historyStore: store });
    try { ${script} } finally { runtime.dispose(); store.close(); }
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TEST_DATA_DIR: dir },
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("runtime flush commits snapshot plus newest tail for a separate process to restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "roost-replay-persist-"));
  try {
    const first = run(dir, `
      store.upsertSession({ id: 'persisted', cwd: process.env.TEST_DATA_DIR });
      const { instanceId } = runtime.ensureSession('persisted', process.env.TEST_DATA_DIR);
      latestPty().emitData('A');
      latestPty().emitData('B');
      if (!runtime.setSnapshot('persisted', 'A', instanceId, 1)) throw Error('snapshot rejected');
      runtime.flush('persisted');
      console.log(JSON.stringify({ instanceId }));
    `);
    const next = run(dir, `
      const record = store.getSessionRecord('persisted');
      runtime.ensureSession(record.id, record.cwd);
      latestPty().emitData('C');
      console.log(JSON.stringify({ replay: runtime.resume('persisted') }));
    `);
    assert.notEqual(next.replay.instanceId, first.instanceId);
    assert.ok(next.replay.data.startsWith("AB"));
    assert.ok(next.replay.data.endsWith("C"));
    assert.equal(next.replay.data.split("A").length - 1, 1);
    assert.equal(next.replay.data.split("B").length - 1, 1);
    assert.equal(next.replay.seq, 1);
    assert.equal(next.replay.truncated, false);
    assert.equal(next.replay.revived, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
