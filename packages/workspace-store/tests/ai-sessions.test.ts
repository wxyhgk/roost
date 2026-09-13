import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "../src/store.ts";
import { createAiSessionBridge } from "@roost/ai-session-bridge";

test("SQLite preserves binding, cursor and retained events across reopen without claiming a live process", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ai-registry-"));
  let store = createWorkspaceStore({ dataDir });
  try {
    let bridge = createAiSessionBridge({ storage: store.aiSessions, maxEvents: 2 });
    bridge.bind({ webSessionId: "web", cliId: "claude", nativeSessionId: "native", terminalInstanceId: "instance" });
    bridge.publish("web", { eventId: "1", type: "message" });
    bridge.publish("web", { eventId: "2", type: "turn-state", state: "running" });
    bridge.publish("web", { eventId: "3", type: "message" });
    store.close(); store = createWorkspaceStore({ dataDir });
    bridge = createAiSessionBridge({ storage: store.aiSessions });
    assert.equal(bridge.get("web")?.state, "offline");
    assert.equal(bridge.read("web").cursor, 3);
    assert.equal(bridge.read("web").hasGap, true);
    assert.deepEqual(bridge.read("web", 2).events.map(event => event.seq), [3]);
    assert.equal(bridge.publish("web", { eventId: "3", type: "message" }), null);
    assert.throws(() => bridge.bind({ webSessionId: "web", cliId: "claude", nativeSessionId: "native", terminalInstanceId: "new" }), /already bound/);
    store.deleteSessionRecord("web");
    assert.deepEqual(store.aiSessions.list(), []);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("source cursor and message commit together; stale gateways cannot overwrite the winner", () => {
  const dataDir=mkdtempSync(join(tmpdir(),"ai-cas-"));
  const store=createWorkspaceStore({dataDir});
  try {
    const first=createAiSessionBridge({storage:store.aiSessions});
    first.bind({webSessionId:"s",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"n"});
    const stale=createAiSessionBridge({storage:store.aiSessions});
    first.publish("s",{eventId:"i:1",type:"message",content:"retained"},{cursor:1,hasGap:false});
    assert.throws(()=>stale.publish("s",{eventId:"bad",type:"message"}),/concurrent/);
    assert.equal(stale.read("s").cursor,0);
    const restored=createAiSessionBridge({storage:store.aiSessions});
    assert.equal(restored.source("s").cursor,1);
    assert.equal(restored.read("s").events[0].event.content,"retained");
    assert.equal(restored.publish("s",{eventId:"i:1",type:"message"},{cursor:1,hasGap:false}),null);
  } finally {store.close();rmSync(dataDir,{recursive:true,force:true});}
});

test("two initially empty registry snapshots cannot bind the same native session to different rows", () => {
  const dataDir=mkdtempSync(join(tmpdir(),"ai-native-unique-"));
  const store=createWorkspaceStore({dataDir});
  try {
    const a=createAiSessionBridge({storage:store.aiSessions}), b=createAiSessionBridge({storage:store.aiSessions});
    a.bind({webSessionId:"a",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"n"});
    assert.throws(()=>b.bind({webSessionId:"b",terminalInstanceId:"j",cliId:"omp",nativeSessionId:"n"}));
    assert.equal(b.get("b"),undefined);assert.equal(store.aiSessions.list().length,1);
  } finally {store.close();rmSync(dataDir,{recursive:true,force:true});}
});
