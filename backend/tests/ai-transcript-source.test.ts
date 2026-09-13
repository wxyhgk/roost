import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@roost/workspace-store";
import { createAiSessionBridge } from "@roost/ai-session-bridge";
import { createAiTranscriptSource } from "../src/ai-transcript-source.ts";
import { readOmpTranscript } from "@roost/ai-transcript";
const header=JSON.stringify({type:"session",version:3,id:"native"})+"\n";
const message=(id:string,role:string,text:string)=>JSON.stringify({type:"message",id,message:{role,content:[{type:"text",text}]}})+"\n";

test("OSC switches to canonical transcript via snapshot, byte checkpoint survives restart, and failure falls back without duplicates",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"transcript-source-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"native.jsonl");await writeFile(path,header+message("u","user","question")+message("a","assistant","answer"));
  let store=createWorkspaceStore({dataDir:join(dir,"db")});
  let bridge=createAiSessionBridge({storage:store.aiSessions});
  bridge.bind({webSessionId:"s",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"native"});
  bridge.publish("s",{eventId:"osc-q",type:"message",role:"user",content:"question",data:{source:"osc777"}});
  bridge.publish("s",{eventId:"osc-a",type:"message",role:"assistant",content:"answer",data:{source:"osc777"}});
  let source=createAiTranscriptSource(bridge,[dir]), resets=0;
  bridge.subscribeSnapshots("s",()=>resets++);
  try {
    await source.catchUp("s");
    assert.equal(resets,1);assert.equal(bridge.get("s")?.transcriptPath,await realpath(path));
    assert.equal(source.status("s").mode,"transcript");
    assert.deepEqual(bridge.read("s").events.filter(e=>e.event.type==="message").map(e=>e.event.eventId),["omp:native:u","omp:native:a"]);
    const revision=bridge.get("s")!.revision, offset=bridge.transcript("s")!.offset;
    await source.catchUp("s");assert.equal(bridge.get("s")!.revision,revision);
    source.dispose();store.close();
    store=createWorkspaceStore({dataDir:join(dir,"db")});bridge=createAiSessionBridge({storage:store.aiSessions});source=createAiTranscriptSource(bridge,[dir]);
    assert.equal(bridge.transcript("s")!.offset,offset);
    await appendFile(path,message("t","toolResult","tool output"));
    await source.catchUp("s");assert.equal(bridge.read("s").events.filter(e=>e.event.type==="message").length,3);
    bridge.transcriptFailed("s",bridge.get("s")!.generation,"unsupported_version");
    assert.deepEqual(bridge.read("s").events.filter(e=>e.event.type==="message").map(e=>e.event.eventId),["osc-q","osc-a"]);
  } finally {source.dispose();store.close();}
});

test("failed batch commit never advances byte offset and late path fills an existing binding",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"transcript-atomic-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"native.jsonl");await writeFile(path,header+message("u","user","question"));
  let fail=false;
  const bridge=createAiSessionBridge({storage:{list:()=>[],remove:()=>{},save:()=>{if(fail)throw new Error("disk full");}}});
  const input={webSessionId:"s",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"native"};
  bridge.bind(input);const binding=bridge.bind({...input,transcriptPath:path});
  assert.equal(binding.transcriptPath,path);
  const batch=await readOmpTranscript(path,"native");
  fail=true;assert.throws(()=>bridge.ingestTranscript("s",binding.generation,batch),/disk full/);
  assert.equal(bridge.transcript("s"),undefined);assert.equal(bridge.read("s").cursor,0);
  fail=false;bridge.ingestTranscript("s",binding.generation,batch);
  assert.equal(bridge.transcript("s")!.offset,batch.checkpoint.offset);
  const changed=bridge.rebind({...input,nativeSessionId:"another"},bridge.get("s")!.generation,bridge.get("s")!.revision);
  assert.equal(bridge.ingestTranscript("s",binding.generation,batch),false);
  assert.equal(bridge.get("s")!.generation,changed.generation);
});

test("native in-place message updates replace visible content and notify snapshot subscribers",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"transcript-update-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"native.jsonl");await writeFile(path,header+message("a","assistant","first"));
  const bridge=createAiSessionBridge();
  const binding=bridge.bind({webSessionId:"s",terminalInstanceId:"i",cliId:"omp",nativeSessionId:"native",transcriptPath:path});
  const batch=await readOmpTranscript(path,"native");bridge.ingestTranscript("s",binding.generation,batch);
  let snapshots=0;bridge.subscribeSnapshots("s",()=>snapshots++);
  const item=structuredClone(batch.items[0]);item.content="updated";item.data.parts[0].text="updated";
  bridge.ingestTranscript("s",binding.generation,{...batch,reset:false,items:[item],details:[item]});
  const messages=bridge.read("s").events.filter(e=>e.event.type==="message");
  assert.equal(messages.length,1);assert.equal(messages[0].event.content,"updated");assert.equal(snapshots,1);
  bridge.ingestTranscript("s",binding.generation,{...batch,reset:false,items:[item],details:[item]});
  assert.equal(snapshots,1);
});
