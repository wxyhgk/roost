import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { MAX_WS_BYTES } from "@roost/terminal-protocol";
import { MAX_HTTP_BYTES } from "../src/http.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestPty } from "./helpers/fake-pty.ts";
const { createWorkspaceStore } = await import("@roost/workspace-store");
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
const { createBackendServer } = await import("../src/server.ts");
const dir = mkdtempSync(join(tmpdir(), "roost-protocol-"));
const store = createWorkspaceStore({ dataDir: dir });
const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/zsh", env: {}, historyStore: store });
store.upsertSession({ id: "isolated", cwd: dir, title: "Isolated" });
const { instanceId } = runtime.ensureSession("isolated", dir);
const pty = latestPty();
const noop = () => {};
const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
let base: string;
const clients = new Set<WebSocket>();
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  for (const client of clients) client.terminate();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  runtime.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
async function connect() {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/pty?id=isolated`);
  clients.add(ws);
  ws.on("error", noop);
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "ready", protocol: 2, instanceId, cols: 80, rows: 24 }));
  const pong = once(ws, "pong"); ws.ping(); await pong;
  return ws;
}
async function health() {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
}
test("HTTP rejects non-object/malformed/oversize bodies and remains usable", { timeout: 10_000 }, async () => {
  for (const body of ["null", "[]", "12", '"string"', "{"]) {
    const result = await fetch(`${base}/api/workspace`, { method: "PATCH", body });
    assert.equal(result.status, 400);
    await result.text();
  }
  const result = await fetch(`${base}/api/workspace`, { method: "PATCH", body: "x".repeat(MAX_HTTP_BYTES + 1) });
  assert.equal(result.status, 413);
  await result.text();
  assert.equal((await fetch(`${base}/api/workspace`, { method: "PATCH", body: "{}" })).status, 200);
  await health();
});
test("bad WS messages close only their connection; peer and HTTP survive", { timeout: 10_000 }, async () => {
  const peer = await connect();
  for (const message of ["null", "[]", "{", '{"type":["input"]}', '{"type":"unknown"}',
    '{"type":"resize","cols":-1,"rows":24}', '{"type":"resize","cols":80.5,"rows":24}',
    '{"type":"ready","cols":80}', '{"type":"resize","cols":80,"rows":1001}', '{"type":"input","data":[]}', '{"type":"input","data":"throw"}']) {
    const bad = await connect();
    const closed = once(bad, "close");
    bad.send(message);
    assert.equal((await closed)[0], 1008);
    await health();
    const pong = once(peer, "pong"); peer.ping(); await pong;
  }
  peer.send(JSON.stringify({ type: "input", data: "still works" }));
  const pong = once(peer, "pong"); peer.ping(); await pong;
  assert.ok(pty.writes.includes("still works"));
});
test("128k escaped snapshot works; oversize text and binary close only sender", { timeout: 10_000 }, async () => {
  const peer = await connect();
  const data = "\x1b".repeat(128000);
  peer.send(JSON.stringify({ type: "snapshot", data, instanceId, seq: 0 }));
  const pong = once(peer, "pong"); peer.ping(); await pong;
  assert.equal(runtime.resume("isolated")?.data, data);
  for (const data of ["x".repeat(MAX_WS_BYTES + 1), Buffer.alloc(MAX_WS_BYTES + 1)]) {
    const bad = await connect();
    const closed = once(bad, "close"); bad.send(data);
    assert.equal((await closed)[0], 1009);
    await health();
  }
  const alive = once(peer, "pong"); peer.ping(); await alive;
});
