import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTerminalOwner } from "../src/owner.ts";
import { connectTerminalDaemon } from "../src/client.ts";
test("daemon journals structured output with no gateway connected and replays to a new client", {timeout:15000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"agent-owner-")),socketPath=join(dir,"d.sock");
  const owner=await startTerminalOwner({dataDir:dir,socketPath,shell:"/bin/sh",defaultCwd:dir});
  let client=await connectTerminalDaemon(socketPath);
  try {
    assert.equal(client.supportsAgentReplay?.(),true);
    const session=await client.ensureSession("s",dir);
    client.writeSession("s",`sleep 0.2; printf '\\033]777;notify;warp://cli-agent;{"event":"session_start","session_id":"native"}\\007'\n`);
    client.dispose();
    let observed=false;
    for(let i=0;i<100;i++) {
      await new Promise(r=>setTimeout(r,25));
      // Polling via a new connection verifies the IPC replay boundary, not only the in-memory owner.
      client=await connectTerminalDaemon(socketPath);
      const page=await client.readAgentEvents!("s",session.instanceId,0);
      if(page.events.length) { assert.equal(page.events[0].sourceSeq,1);assert.equal(page.events[0].agent.sessionId,"native");observed=true;break; }
      client.dispose();
    }
    assert.equal(observed,true);
    assert.equal(client.getSession("s")?.pid,session.pid);
    const tail=await client.readAgentEvents!("s",session.instanceId,1);
    assert.deepEqual(tail.events,[]);
  } finally {client.dispose();await owner.stop();await rm(dir,{recursive:true,force:true});}
});

test("a legacy owner without capability remains connectable and rejects replay locally",async()=>{
  const {createServer}=await import("node:net");
  const dir=await mkdtemp(join(tmpdir(),"agent-legacy-")),socketPath=join(dir,"d.sock");
  const server=createServer(socket=>socket.write(JSON.stringify({type:"hello",version:1,pid:process.pid,sessions:[]})+"\n"));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  const client=await connectTerminalDaemon(socketPath);
  try {
    assert.equal(client.supportsAgentReplay?.(),false);
    assert.deepEqual(client.listSessions(),[]);
    await assert.rejects(client.readAgentEvents!("s","i",0),/unsupported/);
  } finally {client.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
