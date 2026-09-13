import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestPty, type FakePty } from "./helpers/fake-pty.ts";

type Frame = { instanceId: string; seq: number; data: string };
type Message = Partial<Frame> & { type: string; pid?: number; protocol?: number; owner?: boolean };
const { createWorkspaceStore } = await import("@roost/workspace-store");
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
const { createBackendServer } = await import("../src/server.ts");
const dir = mkdtempSync(join(tmpdir(), "roost-resume-"));
const store = createWorkspaceStore({ dataDir: dir });
/*
  这一组测试守的是**退路**的不变式：迟到的快照不能吞掉已发出的输出、伪造的快照不能毒到
  别人、截断的历史里鼠标模式还能被重新声明。服务端网格优先之后，这些路径在正常情况下
  根本不会被走到——那时测试会因为「测不到」而变绿，比红了还糟。所以显式跑在退路上。

  网格那条路由 packages/terminal-runtime/tests 覆盖。
*/
const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/zsh", env: {}, historyStore: store, serverScreen: false });
const ptys = new Map<string, FakePty>();
const server = createBackendServer({ auth: false, store, runtime, workspaceRoot: dir });
const sockets = new Set<WebSocket>();
let base: string;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  runtime.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function session(id: string) {
  store.upsertSession({ id, cwd: dir, title: id });
  runtime.ensureSession(id, dir);
  ptys.set(id, latestPty());
  return id;
}
function emit(id: string, data: string): Frame {
  ptys.get(id)!.emitData(data);
  const frame = runtime.resume(id)!;
  return { instanceId: frame.instanceId, seq: frame.seq, data };
}
async function connect(id: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/pty?id=${id}`);
  sockets.add(ws);
  const messages: Message[] = [];
  const hello = new Promise<Message>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(String(raw)) as Message;
      messages.push(message);
      if (message.type === "hello") resolve(message);
    });
  });
  return { ws, messages, hello: await hello };
}
type Client = Awaited<ReturnType<typeof connect>>;
async function barrier(client: Client) {
  const pong = once(client.ws, "pong"); client.ws.ping(); await pong;
}
async function ready(client: Client, cursor?: { instanceId: string; afterSeq: number }, legacy = false) {
  const replay = new Promise<void>(resolve => {
    const receive = (raw: unknown) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'replay' || message.type === 'catchup') {
        client.ws.off('message', receive); resolve();
      }
    };
    client.ws.on('message', receive);
  });
  client.ws.send(JSON.stringify(legacy ? { type: "ready", haveSnapshot: true, cols: 80, rows: 24 } : {
    type: "ready", protocol: 2, instanceId: cursor?.instanceId ?? client.hello.instanceId,
    ...(cursor ? { afterSeq: cursor.afterSeq } : {}), cols: 80, rows: 24,
  }));
  await replay;
  await barrier(client);
}
function transfers(client: Client) {
  return client.messages.filter(message => ["replay", "catchup", "output"].includes(message.type));
}
function data(client: Client) { return transfers(client).map(message => message.data ?? "").join(""); }
async function close(client: Client) {
  const closed = once(client.ws, "close"); client.ws.close(); await closed;
}

test("only the elected view can reply to color queries and ownership transfers on disconnect", { timeout: 10_000 }, async () => {
  const id = session("appearance-owner");
  const first = await connect(id); await ready(first);
  const second = await connect(id); await ready(second);
  await barrier(first);
  assert.equal(first.messages.filter(m => m.type === "appearance-owner").at(-1)?.owner, true);
  assert.equal(second.messages.filter(m => m.type === "appearance-owner").at(-1)?.owner, false);
  const response = (client: Client, text: string) => client.ws.send(JSON.stringify({ type: "appearance-response", instanceId: client.hello.instanceId, data: text }));
  response(second, "passive"); response(first, "primary");
  await barrier(first); await barrier(second);
  assert.deepEqual(ptys.get(id)!.writes, ["primary"]);
  const promoted = new Promise<void>(resolve => second.ws.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.type === "appearance-owner" && message.owner) resolve();
  }));
  await close(first); await promoted;
  response(second, "promoted"); await barrier(second);
  assert.deepEqual(ptys.get(id)!.writes, ["primary", "promoted"]);
  await close(second);
});

test("delayed snapshot A preserves B already emitted before snapshot arrival", { timeout: 10_000 }, async () => {
  const id = session("delayed");
  const writer = await connect(id); await ready(writer);
  const a = emit(id, "|A|"); emit(id, "|B|"); await barrier(writer);
  writer.ws.send(JSON.stringify({ type: "snapshot", instanceId: a.instanceId, seq: a.seq, data: "SNAP[A]" }));
  await barrier(writer);
  const reader = await connect(id); await ready(reader);
  assert.equal(data(reader), "SNAP[A]|B|");
  assert.equal(transfers(reader).at(-1)?.seq, 2);
});

test("two connections resume independent cursors and receive the same next sequence", { timeout: 10_000 }, async () => {
  const id = session("two-cursors");
  const a = emit(id, "A"); emit(id, "B"); emit(id, "C");
  const one = await connect(id); const two = await connect(id);
  await ready(one, { instanceId: a.instanceId, afterSeq: 1 });
  await ready(two, { instanceId: a.instanceId, afterSeq: 2 });
  assert.equal(data(one), "BC"); assert.equal(data(two), "C");
  emit(id, "D"); await barrier(one); await barrier(two);
  assert.equal(data(one), "BCD"); assert.equal(data(two), "CD");
  assert.equal(transfers(one).at(-1)?.seq, 4); assert.equal(transfers(two).at(-1)?.seq, 4);
});

test("disconnect and resume does not repeat or omit output", { timeout: 10_000 }, async () => {
  const id = session("reconnect");
  const first = await connect(id); await ready(first);
  emit(id, "A"); const b = emit(id, "B"); await barrier(first);
  assert.equal(data(first), "AB"); await close(first);
  emit(id, "C"); emit(id, "D");
  const next = await connect(id); await ready(next, { instanceId: b.instanceId, afterSeq: b.seq });
  assert.equal(data(next), "CD"); assert.equal(transfers(next).at(-1)?.seq, 4);
  emit(id, "E"); await barrier(next);
  assert.equal(data(next), "CDE"); assert.equal(transfers(next).at(-1)?.seq, 5);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("same PID with new instance rejects previous instance cursor", { timeout: 10_000 }, async () => {
  const id = session("new-instance");
  const old = emit(id, "OLD"); const first = await connect(id); await ready(first); await close(first);
  ptys.get(id)!.emitExit(); session(id);
  const current = emit(id, "NEW"); const next = await connect(id);
  assert.equal(first.hello.pid, next.hello.pid);
  assert.notEqual(first.hello.instanceId, next.hello.instanceId);
  await ready(next, { instanceId: old.instanceId, afterSeq: old.seq });
  assert.equal(transfers(next)[0]?.type, "replay");
  assert.equal(transfers(next).at(-1)?.instanceId, current.instanceId);
  assert.equal(transfers(next).at(-1)?.seq, 1);
  assert.ok(data(next).endsWith("NEW"));
});

test("snapshot beyond this connection's sent sequence and stale instance cannot poison peers", { timeout: 10_000 }, async () => {
  const id = session("untrusted-snapshot");
  const good = await connect(id); await ready(good);
  const a = emit(id, "A"); emit(id, "B"); await barrier(good);
  good.ws.send(JSON.stringify({ type: "snapshot", instanceId: a.instanceId, seq: 1, data: "SNAP[A]" }));
  await barrier(good);
  const bad = await connect(id);
  bad.ws.send(JSON.stringify({ type: "snapshot", instanceId: a.instanceId, seq: 2, data: "POISON" }));
  await barrier(bad); await ready(bad);
  bad.ws.send(JSON.stringify({ type: "snapshot", instanceId: a.instanceId, seq: 999, data: "FUTURE_POISON" }));
  await barrier(bad);
  bad.ws.send(JSON.stringify({ type: "snapshot", instanceId: "previous-instance", seq: 2, data: "OLD_POISON" }));
  await barrier(bad);
  const reader = await connect(id); await ready(reader);
  assert.equal(data(reader), "SNAP[A]B");
  assert.equal(bad.ws.readyState, WebSocket.OPEN);
});

test("legacy ready with untrusted haveSnapshot still receives full replay", { timeout: 10_000 }, async () => {
  const id = session("legacy"); emit(id, "AB");
  const client = await connect(id); await ready(client, undefined, true);
  assert.equal(transfers(client)[0]?.type, "replay");
  assert.equal(data(client), "AB");
});

test("mouse modes survive truncated history and a reconnect mid control sequence", { timeout: 10_000 }, async () => {
  const id = session("mouse-recovery");
  emit(id, '\x1b[?1003;1006h');
  const current = emit(id, 'x'.repeat(400_001));
  const reader = await connect(id); await ready(reader);
  assert.ok(data(reader).endsWith('\x1b[?1003;1006h'));
  const cached = await connect(id);
  await ready(cached, { instanceId: current.instanceId, afterSeq: current.seq });
  assert.equal(transfers(cached)[0]?.type, 'catchup');
  assert.ok(data(cached).endsWith('\x1b[?1003;1006h'));
  // The next reconnect lands between two fragments of a color command.
  emit(id, '\x1b[38;2;1');
  const partial = await connect(id); await ready(partial);
  assert.ok(data(partial).endsWith('\x1b[38;2;1'));
  emit(id, ';2;3mLATEST'); await barrier(partial); await barrier(reader);
  assert.ok(data(partial).includes('\x1b[38;2;1;2;3m'));
  assert.ok(data(partial).endsWith('\x1b[?1003;1006hLATEST'));
  assert.equal(transfers(partial).at(-1)?.seq, 4);
  emit(id, '\x1b[?1003;1006l');
  const shell = await connect(id); await ready(shell);
  assert.ok(!data(shell).endsWith('h'));
});

test("DELETE project returns ungrouped workspace while its connected PTY keeps working", { timeout: 10_000 }, async () => {
  const projectId = "delete/project";
  store.createProject({ id: projectId });
  store.setExpandedProjectIds([projectId]);
  const id = session("project-live-session");
  store.setSessionProject(id, projectId); store.setSelectedId(id);
  store.upsertSession({ id: "project-hidden-session", cwd: dir, projectId, closed: true });
  store.setTerminalReplay("project-hidden-session", "SAVED HIDDEN HISTORY", null);
  const client = await connect(id); await ready(client);
  emit(id, "BEFORE_DELETE"); await barrier(client);
  runtime.flush(id);
  const live = runtime.getSession(id)!;
  const history = store.getTerminalReplay(id);
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  const workspace = await response.json();
  assert.ok(!workspace.projects.some((p: { id: string }) => p.id === projectId));
  assert.ok(!workspace.expandedProjectIds.includes(projectId));
  assert.equal(workspace.selectedId, id);
  for (const sessionId of [id, "project-hidden-session"]) {
    assert.equal(workspace.sessions.find((s: { id: string }) => s.id === sessionId).projectId, null);
  }
  assert.deepEqual(runtime.getSession(id), live);
  assert.deepEqual(store.getTerminalReplay(id), history);
  assert.equal(store.getTerminalReplay("project-hidden-session")?.raw, "SAVED HIDDEN HISTORY");
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  client.ws.send(JSON.stringify({ type: "input", data: "AFTER_DELETE_INPUT" })); await barrier(client);
  assert.equal(ptys.get(id)!.writes.at(-1), "AFTER_DELETE_INPUT");
  emit(id, "AFTER_DELETE_OUTPUT"); await barrier(client);
  assert.ok(data(client).endsWith("AFTER_DELETE_OUTPUT"));
  const missing = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "project not found");
  assert.equal(runtime.getSession(id)?.instanceId, live.instanceId);
});

test('asynchronous daemon replay neither loses nor duplicates events at the subscription boundary', async () => {
  const id=session('async-boundary');
  const isolated=createBackendServer({ auth: false,store,workspaceRoot:dir,runtime:{...runtime,
    resume:async (sessionId,cursor)=>{
      emit(id,'BEFORE_BOUNDARY');
      const replay=runtime.resume(sessionId,cursor);
      emit(id,'AFTER_BOUNDARY');
      await new Promise(resolve=>setTimeout(resolve,20));
      return replay;
    },
  }});
  isolated.listen(0,'127.0.0.1');await once(isolated,'listening');
  const ws=new WebSocket(`ws://127.0.0.1:${(isolated.address() as {port:number}).port}/api/pty?id=${id}`);
  const frames:Message[]=[];
  try {
    await new Promise<void>((resolve,reject)=>{
      ws.on('error',reject);
      ws.on('message',raw=>{
        const frame=JSON.parse(String(raw));frames.push(frame);
        if(frame.type==='hello')ws.send(JSON.stringify({type:'ready',protocol:2,cols:80,rows:24}));
        if(frame.type==='output'&&frame.data==='AFTER_BOUNDARY')resolve();
      });
    });
    assert.equal(frames.filter(frame=>['replay','output'].includes(frame.type)).map(frame=>frame.data).join(''),'BEFORE_BOUNDARYAFTER_BOUNDARY');
  } finally {ws.terminate();await new Promise<void>(resolve=>isolated.close(()=>resolve()))}
});


test('passive and legacy ready never resize a shared PTY; explicit resize still works', async () => {
  const id = session('passive-size');
  const pty = ptys.get(id)!;
  const sizes: number[][] = [];
  pty.resize = (cols, rows) => { sizes.push([cols, rows]); };
  const active = await connect(id); await ready(active);
  assert.deepEqual(sizes, []);
  active.ws.send(JSON.stringify({ type: 'resize', cols: 160, rows: 48 }));
  // Runtime here is local and synchronous; await a real resize effect, not pong.
  for (let i=0; i<100 && sizes.length===0; i++) await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(sizes, [[160,48]]);
  const observer = await connect(id); await ready(observer, undefined, true);
  const reconnect = await connect(id); await ready(reconnect);
  assert.deepEqual(sizes, [[160,48]]);
  assert.equal(pty.pid, active.hello.pid);
});

test('negotiated application heartbeat responds without writing to the PTY', async () => {
  const id = session('heartbeat');
  const client = await connect(id); await ready(client);
  assert.equal((client.hello as Message & { heartbeat?: number }).heartbeat, 1);
  const before = [...ptys.get(id)!.writes];
  const pong = new Promise<void>(resolve => client.ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'pong' && m.nonce === 42) resolve(); }));
  client.ws.send(JSON.stringify({ type: 'ping', nonce: 42 }));
  await pong;
  assert.deepEqual(ptys.get(id)!.writes, before);
});
