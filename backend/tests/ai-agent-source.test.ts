import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestPty } from "./helpers/fake-pty.ts";
import { createWorkspaceStore } from "@roost/workspace-store";
const { createTerminalRuntime } = await import("@roost/terminal-runtime");
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createAiAgentSource, followsToLivePty, projectAgentEvent } from "../src/ai-agent-source.ts";

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

/*
  **同一段对话换了一条 PTY，绑定要跟过去。**

  绑定记的 `terminalInstanceId` 是 PTY 进程的身份，而它是 `replay.ts` 里当场 randomUUID
  生成、不落盘的——守护进程一重启全部换新。绑定却把它当成不可变的键，于是 PTY 一换代
  绑定就永久失联：新实例上的事件在到达绑定之前就被「实例号不符」丢掉，界面从此停更，
  而且没有任何自动路径能把它拉回来。

  实测过：一台机器上七条绑定，凡是终端换过 PTY 代的全部卡死、没换过的全部正常，
  相关性 100%。手工调一次换绑接口能救回来，但寿命只到下一次守护进程重启为止。

  **判据是 native 会话 id**，不是进程号：`claude --resume` 的全部意义就是让同一段对话
  活过进程的死亡，所以 CLI 自己报的那个 id 才是这段对话的身份。上面那条用例钉的是
  相反的一半——换了 PTY **又换了 native**，那是另一段对话，绝不能认领。两条合起来才完整。
*/
test("同一个 native 会话换到新的 PTY 上时，绑定跟着走", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-source-follow-"));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  store.upsertSession({ id: "web", cwd: dir });
  await runtime.ensureSession("web", dir);
  const getSession = runtime.getSession;
  runtime.getSession = id => { const live = getSession(id); return live ? { ...live, cli: "omp" } : undefined; };
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const source = createAiAgentSource(store, runtime, bridge);
  const send = (event: object) => latestPty().emitData("\x1b]777;notify;warp://cli-agent;" + JSON.stringify(event) + "\x07");
  try {
    send({ event: "session_start", session_id: "native" });
    const firstInstance = runtime.getSession("web")!.instanceId;
    assert.equal(bridge.get("web")?.terminalInstanceId, firstInstance);

    // 换一条 PTY：守护进程重启、会话 resume、终端重开，都是这个形状。
    await runtime.killSession("web");
    await runtime.ensureSession("web", dir);
    const secondInstance = runtime.getSession("web")!.instanceId;
    assert.notEqual(secondInstance, firstInstance, "新 PTY 必须是新实例，否则这条用例什么都没测");

    /*
      先 refresh 一次再发事件。PTY 退出时运行时会把订阅者整份抹掉，要等 source 重新订上
      才收得到——生产里那是 250ms 定时器做的，这里显式调一次，免得测试去睡一觉。
    */
    source.refresh();
    // CLI 在新进程里报出**同一个** native 会话——`--resume` 之后就是这样。
    send({ event: "session_start", session_id: "native" });

    assert.equal(bridge.get("web")?.nativeSessionId, "native", "还是同一段对话");
    assert.equal(bridge.get("web")?.terminalInstanceId, secondInstance,
      "绑定必须跟到当前活着的 PTY 上——否则它再也收不到任何事件");
    assert.notEqual(bridge.get("web")?.state, "offline", "跟过去之后不该还停在 offline");
  } finally { source.dispose(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/*
  「能不能跟到新 PTY 上」这四条判据，逐条钉住。

  端到端驱动不出全部四条——`live.instanceId === instance` 那条只在**重放**路径上才有区别
  （实时路径里这两个值恒等），而 `sessionId` 那条本来有一条端到端用例，却因为一个时序坑
  变成了空过：`killSession` 会把该会话的订阅者整份抹掉，那条用例在重建 PTY 之后没等
  重新订阅就发事件，于是事件根本没到，断言是「因为什么都没发生」才通过的。

  变异测试戳穿了这两处：把「native 必须相同」和「必须是活着的 PTY」删掉，全套照样绿。
  所以判据提成纯函数直接测——每一条删掉都要有人喊。
*/
const liveSession = (instanceId: string, cli: string) => ({ instanceId, cli } as never);
const bound = (instanceId: string, cliId: string, nativeSessionId: string) =>
  ({ terminalInstanceId: instanceId, cliId, nativeSessionId } as never);
const agentEvent = (agent: object, terminalInstanceId?: string) =>
  ({ type: "agent", agent, terminalInstanceId } as never);

test("跟到新 PTY 的四条判据：少一条都会认错对话", () => {
  const old = bound("dead", "claude", "native-1");

  // 基线：同一家 CLI、同一个 native、事件来自此刻活着的那条 PTY。
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "live",
    agentEvent({ event: "session_start", sessionId: "native-1" })), true);

  /*
    ① 只跟到**此刻活着**的那条 PTY。少了它，一条早就死掉的 PTY 的迟到重放事件也能
    把绑定拽走——而那条 PTY 里跑的东西早就不在了。
  */
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "another-dead",
    agentEvent({ event: "session_start", sessionId: "native-1" }, "another-dead")), false,
    "事件来自一条不是当前活着的 PTY，不许跟过去");
  assert.equal(followsToLivePty(old, undefined, "live",
    agentEvent({ event: "session_start", sessionId: "native-1" })), false, "没有活着的 PTY 时不许跟");

  /*
    ② 同一个 native 会话。这是和「a replacement must not be consumed」的分界线：
    换了 PTY **又换了 native**，那是另一段对话，认领它等于把两段对话拼成一段。
  */
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "live",
    agentEvent({ event: "session_start", sessionId: "native-2" })), false,
    "换了 PTY 又换了 native——那是另一段对话");
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "live",
    agentEvent({ event: "session_start" })), false, "没报 native 就没有证据，不许跟");

  /* ③ 同一家 CLI。跨 CLI 的收养另有一条更严的路（要求同一条 PTY、显式标签、连续日志）。 */
  assert.equal(followsToLivePty(old, liveSession("live", "codex"), "live",
    agentEvent({ event: "session_start", sessionId: "native-1" })), false, "换了 CLI 不走这条路");
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "live",
    agentEvent({ event: "session_start", sessionId: "native-1", agent: "codex" })), false,
    "事件自带的标签和绑定的 CLI 对不上——那是同一条日志里别人的尾巴");

  /* ④ 事件本身要能确立身份。未知事件、纯状态事件都不行。 */
  assert.equal(followsToLivePty(old, liveSession("live", "claude"), "live",
    agentEvent({ event: "tasks_updated", sessionId: "native-1" })), false, "确立不了身份的事件不算证据");
});

/*
  端到端的反面：换了 PTY **又换了 native**，绑定必须原地不动。

  这一条原本存在于上面那条长用例的末尾，但它踩了订阅被抹掉的时序坑，实际是空过的
  （变异测试发现）。这里按正确时序重写一遍——先 refresh 重新订上，再发事件。
*/
test("换了 PTY 又换了 native：绑定不许跟过去", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-source-nofollow-"));
  const store = createWorkspaceStore({ dataDir: dir });
  const runtime = createTerminalRuntime({ defaultCwd: dir, shell: "/bin/sh", env: {}, historyStore: store });
  store.upsertSession({ id: "web", cwd: dir });
  await runtime.ensureSession("web", dir);
  const getSession = runtime.getSession;
  runtime.getSession = id => { const live = getSession(id); return live ? { ...live, cli: "omp" } : undefined; };
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  const source = createAiAgentSource(store, runtime, bridge);
  const send = (event: object) => latestPty().emitData("\x1b]777;notify;warp://cli-agent;" + JSON.stringify(event) + "\x07");
  try {
    send({ event: "session_start", session_id: "native" });
    const first = runtime.getSession("web")!.instanceId;

    await runtime.killSession("web");
    await runtime.ensureSession("web", dir);
    source.refresh();
    // 新 PTY 里是**另一段**对话。
    send({ event: "session_start", session_id: "replacement" });

    const binding = bridge.get("web");
    assert.equal(binding?.nativeSessionId, "native", "绝不能把另一段对话认领过来");
    assert.equal(binding?.terminalInstanceId, first, "绑定该原地不动，等人工决定");
  } finally { source.dispose(); runtime.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/*
  重放路径上的「跟到活着的那条 PTY 上」。

  **这和实时路径是两份实现**，而 daemon 支持重放时，实时那条是死代码
  （`if (replaySupported()) void pump(id); else if (connected()) {…}`）。上一轮只修了实时
  那半边，于是真机上守护进程重启之后绑定照样一动不动——盯了 150 秒，期间 CLI 正常发过
  Stop 钩子，绑定始终钉在上一代的实例号上。

  钉死它的是两处：`instance` 取的是**绑定自己**记的实例，永远只读那条已经死掉的 PTY 的
  日志；`stillCurrent()` 里「活 PTY 和 instance 不符就 false」让整个 pump 当场退出。
*/
function journal(instance: string, native: string, extra: { event: string; query?: string }[] = []) {
  const events = [{ sourceSeq: 1, terminalInstanceId: instance,
    agent: { event: "session_start", sessionId: native } },
    ...extra.map((e, index) => ({ sourceSeq: index + 2, terminalInstanceId: instance,
      agent: { sessionId: native, ...e } }))];
  const high = events.length;
  return async (after: number) => ({
    events: events.filter(e => e.sourceSeq > after), cursor: high, highWater: high, more: false, hasGap: false,
  }) as never;
}

test("重放路径：守护进程换了一代 PTY，绑定按 native 跟过去", async () => {
  const f = replayFixture();
  try {
    assert.equal(f.bridge.get("s")?.terminalInstanceId, "i");
    // 守护进程重启：同一条终端，新的 PTY 进程号；里面还是同一段对话（native 仍是 A）。
    f.setInstance("i2");
    f.setRead(journal("i2", "A"));
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")?.terminalInstanceId, "i2", "绑定必须跟到活着的那条 PTY 上");
    assert.equal(f.bridge.get("s")?.nativeSessionId, "A", "跟过去的是同一段对话，native 不变");
    assert.notEqual(f.bridge.get("s")?.state, "offline");
  } finally { f.close(); }
});

test("重放路径：新 PTY 里是另一段对话，绝不认领", async () => {
  const f = replayFixture();
  try {
    f.setInstance("i2");
    // 同一条终端上换了一条 PTY，但里面跑的是**别的** native 会话。
    f.setRead(journal("i2", "B"));
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")?.terminalInstanceId, "i", "绑定该原地不动，等人工决定");
    assert.equal(f.bridge.get("s")?.nativeSessionId, "A", "绝不能把另一段对话拼进来");
    assert.equal(f.source.status("s").lastError, "needs_rebind", "要说得出为什么停下");
  } finally { f.close(); }
});

test("重放路径：跟不过去时节流，不把整条日志每 250ms 重读一遍", async () => {
  const f = replayFixture();
  try {
    f.setInstance("i2");
    let reads = 0;
    const read = journal("i2", "B");
    f.setRead(async (after: number) => { reads++; return read(after); });
    await f.source.catchUp("s");
    const first = reads;
    assert.ok(first > 0, "第一次要真的去读");
    await f.source.catchUp("s");
    await f.source.catchUp("s");
    assert.equal(reads, first, "同一条 PTY 上连续失败要退避，否则 pump 每 250ms 拖一遍整条日志");
  } finally { f.close(); }
});

test("重放路径：新 PTY 里换了 CLI，不走这条路", async () => {
  const f = replayFixture();
  try {
    f.setInstance("i2");
    f.setCli("codex");
    // native 对得上，但那条 PTY 里跑的是另一家 CLI。
    f.setRead(journal("i2", "A"));
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")?.terminalInstanceId, "i",
      "跨 CLI 另有一条更严的路（要求显式标签和连续日志），不能从这里溜进去");
    assert.equal(f.bridge.get("s")?.cliId, "omp", "更不能给跑着别家 CLI 的 PTY 贴上旧标签");
  } finally { f.close(); }
});

test("重放路径：跟过去之后，这一拍就把新 PTY 的事件读完", async () => {
  const f = replayFixture();
  try {
    f.setInstance("i2");
    f.setRead(journal("i2", "A", [{ event: "prompt_submit", query: "新 PTY 上的第一句" }]));
    await f.source.catchUp("s");
    assert.equal(f.bridge.get("s")?.terminalInstanceId, "i2");
    assert.equal(f.bridge.source("s").cursor, 2,
      "跟过去之后必须接着往下读——漏了这一步，绑定挪了但内容要等下一拍，界面会空一下");
    assert.equal(f.bridge.get("s")?.state, "running", "新 PTY 上那条事件要真的被投影");
  } finally { f.close(); }
});
