import test from "node:test";
import assert from "node:assert/strict";
import type { TerminalService } from "@roost/terminal-runtime";
import type { WorkspaceStore } from "@roost/workspace-store";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createDiagnostics } from "../src/diagnostics.ts";

test("diagnostics distinguishes a live legacy daemon from replay support and excludes message bodies", () => {
  let connected = true;
  const bridge = createAiSessionBridge();
  bridge.bind({webSessionId:"s",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"n"});
  bridge.publish("s",{eventId:"1",type:"message",content:"PRIVATE_PROMPT"});
  const runtime = {
    ownerPid:123, isConnected:()=>connected, supportsAgentReplay:()=>false,
    listSessions:()=>{if(!connected)throw new Error("unavailable");return [{id:"s"}];},
  } as unknown as TerminalService;
  const diagnostics = createDiagnostics({} as WorkspaceStore,runtime,bridge,()=>({hasGap:false,lastError:null}));
  const first = diagnostics();
  assert.equal(first.daemon.connected,true);
  assert.equal(first.daemon.agentReplaySupported,false);
  assert.equal(first.daemon.liveSessionCount,1);
  assert.equal(first.daemon.pid,123);
  assert.equal(first.ai.bindings,1);
  assert.ok(!JSON.stringify(first).includes("PRIVATE_PROMPT"));
  connected = false;
  const second = diagnostics();
  assert.equal(second.daemon.connected,false);
  assert.equal(second.daemon.liveSessionCount,null);
  assert.equal(second.gateway.startedAt,first.gateway.startedAt);
  assert.equal(bridge.read("s").cursor,1,"diagnostics does not write events");
});
