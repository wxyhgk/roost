import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestPty } from "./helpers/fake-pty.ts";
import { createWorkspaceStore } from "@roost/workspace-store";
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createAiAgentSource, projectAgentEvent } from "../src/ai-agent-source.ts";

test("live OSC notifications bind native identity, persist messages/state, and never replay screen output as messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-source-"));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  store.upsertSession({ id: "web", cwd: dir });
  await runtime.ensureSession("web", dir);
  // Deterministic stand-in for CLI process recognition, retaining the real runtime scanner.
  const getSession = runtime.getSession;
  runtime.getSession = id => { const live = getSession(id); return live ? { ...live, cli: "omp" } : undefined; };
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  let source = createAiAgentSource(store, runtime, bridge);
  const send = (event: object) => latestPty().emitData("\x1b]777;notify;warp://cli-agent;" + JSON.stringify(event) + "\x07");
  try {
    latestPty().emitData("plain screen output");
    send({ event: "prompt_submit", query: "no identity" });
    assert.equal(bridge.get("web"), undefined);
    send({ event: "session_start", session_id: "native" });
    assert.equal(bridge.get("web")?.nativeSessionId, "native");
    send({ event: "prompt_submit", query: "hello" });
    assert.equal(bridge.get("web")?.state, "running");
    send({ event: "permission_request", summary: "run tool" });
    assert.equal(bridge.get("web")?.state, "waiting");
    send({ event: "stop", response: "answer" });
    send({ event: "tool_complete" });
    send({ event: "idle_prompt" });
    assert.equal(bridge.get("web")?.state, "completed");
    assert.deepEqual(bridge.read("web").events.filter(e => e.event.type === "message").map(e => e.event.content), ["hello", "answer"]);
    assert.equal(store.aiSessions.list()[0].binding.state, "completed");
    source.dispose();
    const restored = createAiSessionBridge({ storage: store.aiSessions });
    source = createAiAgentSource(store, runtime, restored);
    send({ event: "prompt_submit", query: "unconfirmed" });
    assert.equal(restored.get("web")?.state, "offline");
    send({ event: "prompt_submit", session_id: "native", query: "confirmed" });
    assert.equal(restored.get("web")?.state, "running");
    await runtime.killSession("web");
    assert.equal(restored.get("web")?.state, "offline");
    await runtime.ensureSession("web", dir);
    send({ event: "session_start", session_id: "replacement" });
    assert.equal(restored.get("web")?.nativeSessionId, "native");
    assert.equal(restored.get("web")?.state, "offline");
  } finally { source.dispose(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("state transitions do not revive a completed turn from a late unblock notification", () => {
  assert.equal(projectAgentEvent({ event: "permission_replied" }, "completed"), null);
  assert.equal(projectAgentEvent({ event: "tool_complete" }, "failed"), null);
  assert.equal(projectAgentEvent({ event: "permission_replied" }, "waiting")?.state, "running");
  assert.equal(projectAgentEvent({ event: "unrecognized" }, "ready"), null);
  assert.equal(projectAgentEvent({ event: "stop_failure" }, "running")?.state, "failed");
});

test("journal replay waits for CLI recognition, resumes durable cursor and ignores old-instance events", async () => {
  const dir=mkdtempSync(join(tmpdir(),"agent-replay-source-"));
  const store=createWorkspaceStore({dataDir:dir});
  store.upsertSession({id:"s",cwd:dir});
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  let cli:string|null=null, connected=true;
  let calls=0;
  const events=[
    {terminalInstanceId:"i",sourceSeq:1,agent:{event:"session_start",sessionId:"n"}},
    {terminalInstanceId:"i",sourceSeq:2,agent:{event:"prompt_submit",sessionId:"n",query:"question"}},
    {terminalInstanceId:"i",sourceSeq:3,agent:{event:"stop",sessionId:"n",response:"answer"}},
  ];
  const runtime={
    getSession:()=>connected?{id:"s",instanceId:"i",pid:1,cwd:dir,cli}:undefined,
    isConnected:()=>connected,supportsAgentReplay:()=>true,
    readAgentEvents:async (_id:string,_instance:string,after:number)=>{
      calls++;return {events:events.filter(e=>e.sourceSeq>after),cursor:3,highWater:3,more:false,hasGap:false};
    },
    subscribe:()=>()=>{},
  } as unknown as import("@roost/terminal-runtime").TerminalService;
  const source=createAiAgentSource(store,runtime,bridge);
  try {
    await source.catchUp("s"); assert.equal(calls,0);assert.equal(bridge.get("s"),undefined);
    cli="omp"; await source.catchUp("s");
    assert.equal(bridge.get("s")?.state,"completed");
    assert.equal(bridge.source("s").cursor,3);
    const cursor=bridge.read("s").cursor;await source.catchUp("s");assert.equal(bridge.read("s").cursor,cursor);
    connected=false;source.refresh();assert.equal(bridge.get("s")?.state,"offline");
  } finally {source.dispose();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("空绑定上的身份改换自动跟随；已同步过正文的则停下等人工换绑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-adopt-"));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  store.upsertSession({ id: "web", cwd: dir });
  await runtime.ensureSession("web", dir);
  const getSession = runtime.getSession;
  runtime.getSession = id => { const live = getSession(id); return live ? { ...live, cli: "omp" } : undefined; };
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const rebound: string[] = [];
  const source = createAiAgentSource(store, runtime, bridge, id => rebound.push(id));
  const send = (event: object) => latestPty().emitData("\x1b]777;notify;warp://cli-agent;" + JSON.stringify(event) + "\x07");
  try {
    // agent 启动时先发的 session_id 常常是临时的：没有内容就不会落盘。
    send({ event: "session_start", session_id: "provisional" });
    const first = bridge.get("web");
    assert.equal(first?.nativeSessionId, "provisional");

    // 随后用户恢复了一段旧对话，身份变了。此刻一条正文都还没有，
    // 没有任何可拼接的东西——拒绝跟随只会把面板永久卡住。
    send({ event: "prompt_submit", session_id: "resumed", query: "继续昨天那个" });
    const moved = bridge.get("web");
    assert.equal(moved?.nativeSessionId, "resumed", "空绑定必须自动跟到新身份");
    assert.notEqual(moved?.generation, first?.generation, "必须开新 generation，不能原地改 ID");
    assert.deepEqual(rebound, ["web"], "必须通知调用方断开旧连接，否则那条流会永远静默");
    // 新一代里只有新会话的内容，旧的不会混进来。
    const events = bridge.read("web", 0, moved!.generation).events;
    assert.deepEqual(events.map(e => e.event.content).filter(Boolean), ["继续昨天那个"]);

    // 有了正文之后再换身份，就必须停下：跟过去会丢掉已经可见的历史。
    send({ event: "stop", response: "好的" });
    assert.equal(bridge.get("web")?.state, "completed");
    const settled = bridge.get("web");
    send({ event: "prompt_submit", session_id: "third", query: "另一段" });
    assert.equal(bridge.get("web")?.nativeSessionId, "resumed", "已有正文时不得自动改换身份");
    assert.equal(bridge.get("web")?.generation, settled?.generation);
    assert.equal(bridge.get("web")?.state, "offline");
    assert.equal(source.status("web").lastError, "needs_rebind");
    assert.deepEqual(rebound, ["web"], "停下的这次不该产生新一代");
  } finally {
    source.dispose(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

function replayFixture(durable = true) {
  const dir = mkdtempSync(join(tmpdir(), "ordered-identity-"));
  const store = createWorkspaceStore({ dataDir: dir });
  store.upsertSession({ id: "s", cwd: dir });
  const bridge = createAiSessionBridge({ storage: durable ? store.aiSessions : undefined });
  const first = bridge.bind({ webSessionId: "s", terminalInstanceId: "i", cliId: "omp", nativeSessionId: "A" });
  bridge.publish("s", { eventId: "i:1", type: "message", role: "user", content: "original A" }, { cursor: 1, hasGap: false });
  let enabled = false, cli = "omp", instance = "i";
  type Replay = Awaited<ReturnType<NonNullable<import("@roost/terminal-runtime").TerminalService["readAgentEvents"]>>>;
  let read: (after: number) => Promise<Replay> = async after => ({ events: [], cursor: after, highWater: after, more: false, hasGap: false });
  const runtime = {
    getSession: () => ({ id: "s", instanceId: instance, cli, pid: 1, cwd: dir }),
    isConnected: () => true, supportsAgentReplay: () => enabled,
    readAgentEvents: (_id: string, _instance: string, after: number) => read(after),
    subscribe: () => () => {},
  } as unknown as import("@roost/terminal-runtime").TerminalService;
  let rebounds = 0;
  const source = createAiAgentSource(store, runtime, bridge, () => { rebounds++; throw new Error("observer failed"); });
  enabled = true;
  return { store, bridge, source, first, setRead: (fn: typeof read) => { read = fn; },
    setCli: (value: string) => { cli = value; }, setInstance: (value: string) => { instance = value; },
    rebounds: () => rebounds, close: () => { source.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const replayEvent = (sourceSeq: number, sessionId: string) => ({
  terminalInstanceId: "i", sourceSeq, agent: { event: "prompt_submit", sessionId, query: sessionId + sourceSeq },
});

test("ordered replay cannot discard existing messages when durable history is unavailable", async () => {
  const f=replayFixture(false);
  try {
    f.setRead(async()=>({events:[replayEvent(2,"B")],cursor:2,highWater:2,more:false,hasGap:false}));
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")!.generation,f.first.generation);
    assert.equal(f.source.status("s").lastError,"needs_rebind");
    assert.equal(f.source.status("s").pendingIdentity?.reason,"history_unavailable");
    assert.equal(f.bridge.read("s").events[0].event.content,"original A");
  } finally { f.close(); }
});

test("ordered replay follows A→B→A, archives SQLite generations and ignores late identities", async () => {
  const f = replayFixture();
  try {
    f.setRead(async after => after === 1
      ? { events: [replayEvent(1, "stale"), replayEvent(2, "B")], cursor: 2, highWater: 3, more: true, hasGap: false }
      : { events: [replayEvent(3, "A"), replayEvent(4, "future")], cursor: 4, highWater: 4, more: false, hasGap: false });
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")?.nativeSessionId, "A");
    assert.equal(f.bridge.source("s").cursor, 3, "first-page horizon excludes later identities");
    assert.equal(f.rebounds(), 2, "throwing observers cannot roll back or repeat committed generations");
    const history = f.store.aiSessions.history!;
    const generations = history.listGenerations("s").items;
    assert.equal(generations.length, 3);
    assert.deepEqual(generations.map(g => g.binding.nativeSessionId), ["A", "B", "A"]);
    assert.deepEqual(history.pageMessages("s", f.first.generation).items.map(m => m.event.content), ["original A"]);
    f.setRead(async after => ({ events: [replayEvent(1, "stale"), replayEvent(2, "B")], cursor: after, highWater: after, more: false, hasGap: false }));
    await f.source.catchUp("s");
    assert.equal(f.rebounds(), 2);
  } finally { f.close(); }
});

test("gaps and malformed old-PTY boundaries never advance identity or cursor; empty polling preserves error", async () => {
  for (const gap of [true, false]) {
    const f = replayFixture();
    try {
      f.setRead(async () => ({ events: [{ ...replayEvent(2, "B"), terminalInstanceId: gap ? "i" : "old" }], cursor: 2, highWater: 2, more: false, hasGap: gap }));
      await f.source.catchUp("s");
      assert.equal(f.bridge.get("s")?.generation, f.first.generation);
      assert.equal(f.bridge.source("s").cursor, 1);
      assert.equal(f.source.status("s").lastError, gap ? "needs_rebind" : "invalid_replay");
      f.setRead(async after => ({ events: [], cursor: after, highWater: after, more: false, hasGap: false }));
      await f.source.catchUp("s");
      assert.equal(f.source.status("s").lastError, gap ? "needs_rebind" : "invalid_replay");
    } finally { f.close(); }
  }
});

test("asynchronous replay rechecks external rebind, CLI and PTY changes before applying the page", async () => {
  for (const mutation of ["rebind", "cli", "pty"] as const) {
    const f = replayFixture();
    try {
      f.setRead(async () => {
        if (mutation === "rebind") {
          const b = f.bridge.get("s")!;
          f.bridge.rebind({ ...b, nativeSessionId: "manual" }, b.generation, b.revision);
        } else if (mutation === "cli") f.setCli("claude");
        else f.setInstance("new");
        return { events: [replayEvent(2, "B")], cursor: 2, highWater: 2, more: false, hasGap: false };
      });
      await f.source.catchUp("s");
      assert.equal(f.bridge.get("s")?.nativeSessionId, mutation === "rebind" ? "manual" : "A");
      assert.equal(f.rebounds(), 0);
    } finally { f.close(); }
  }
});

test("external mutation between replay pages stops the bounded pass after its own adoption", async () => {
  for (const mutation of ["rebind", "cli", "dispose"] as const) {
    const f = replayFixture();
    try {
      f.setRead(async after => {
        if (after === 1) return { events: [replayEvent(2, "B")], cursor: 2, highWater: 3, more: true, hasGap: false };
        await Promise.resolve();
        if (mutation === "rebind") {
          const b = f.bridge.get("s")!;
          f.bridge.rebind({ ...b, nativeSessionId: "manual" }, b.generation, b.revision);
        } else if (mutation === "cli") f.setCli("claude");
        else f.source.dispose();
        return { events: [replayEvent(3, "A")], cursor: 3, highWater: 3, more: false, hasGap: false };
      });
      await f.source.catchUp("s");
      assert.equal(f.bridge.get("s")?.nativeSessionId, mutation === "rebind" ? "manual" : "B");
      assert.equal(f.rebounds(), 1);
    } finally { f.close(); }
  }
});
