import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOmpTranscript, discoverOmpTranscript, readOmpDetail, type TranscriptCheckpoint } from "../src/index.ts";
const header = JSON.stringify({ type: "session", version: 3, id: "native" }) + "\n";
const row = (id: string, role = "assistant", text = "hello") => ({ type: "message", id, parentId: null, timestamp: "2026-09-09T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
test("byte checkpoints preserve split UTF-8/JSON, resume without rereading messages, and detect replacement", async t => {
  const dir = await mkdtemp(join(tmpdir(),"omp-reader-")); t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,"native.jsonl");
  await writeFile(file,header+JSON.stringify(row("one","user","分子".repeat(70000)))+"\n"+JSON.stringify(row("two")));
  let state:TranscriptCheckpoint|undefined; const ids:string[]=[];
  for(let i=0;i<5;i++){const batch=await readOmpTranscript(file,"native",state);assert.ok(batch.bytesRead<=256*1024);assert.deepEqual(batch.details.map(e=>e.eventId),batch.items.map(e=>e.eventId));if(batch.details.length){assert.equal(batch.details[0].content,"分子".repeat(70000));assert.equal(batch.details[0].data.truncated,false);}ids.push(...batch.items.map(e=>e.eventId));state=batch.checkpoint;if(state.offset===state.fileSize)break;}
  assert.deepEqual(ids,["omp:native:one"]);assert.equal(state!.status,"awaiting_line");
  await appendFile(file,"\n");
  const completed=await readOmpTranscript(file,"native",state);assert.equal(completed.items[0].eventId,"omp:native:two");
  const idle=await readOmpTranscript(file,"native",completed.checkpoint);assert.equal(idle.bytesRead,0);assert.equal(idle.items.length,0);assert.equal(idle.details.length,0);
  await writeFile(file+".new",header+JSON.stringify(row("new"))+"\n");await rename(file+".new",file);
  const replaced=await readOmpTranscript(file,"native",idle.checkpoint);assert.equal(replaced.reset,true);assert.equal(replaced.items[0].eventId,"omp:native:new");
  await writeFile(file,header);assert.equal((await readOmpTranscript(file,"native",replaced.checkpoint)).reset,true);
});
test("oversized and unknown records report partial but do not stop later valid messages",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"omp-large-"));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,"native.jsonl");
  await writeFile(file,header+JSON.stringify(row("large","toolResult","x".repeat(1200000)))+"\n"+JSON.stringify({type:"future"})+"\n"+JSON.stringify(row("last"))+"\n");
  let state:TranscriptCheckpoint|undefined;const ids:string[]=[];
  for(let i=0;i<10;i++){const batch=await readOmpTranscript(file,"native",state);state=batch.checkpoint;ids.push(...batch.items.map(e=>e.eventId));if(state.offset===state.fileSize)break;}
  assert.deepEqual(ids,["omp:native:last"]);assert.equal(state!.status,"partial");assert.equal(state!.skipped,2);
});
test("tool summaries preserve call IDs; detail is bounded, read-only and invalidated by edits",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"omp-tools-"));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,"native.jsonl");
  const tool={...row("result","toolResult","x".repeat(9000)),message:{...row("unused","toolResult","x".repeat(9000)).message,toolCallId:"call",toolName:"Bash",isError:false}};
  await writeFile(file,header+JSON.stringify(tool)+"\n");const batch=await readOmpTranscript(file,"native");
  assert.equal(batch.items[0].role,"tool");assert.equal(batch.items[0].data.truncated,true);
  assert.equal(batch.items[0].data.parts[0].toolCallId,"call");
  const detail=await readOmpDetail(batch.items[0].data.detail);assert.ok(detail!.content.length>batch.items[0].content.length);
  assert.deepEqual(batch.details,[detail]);assert.equal(batch.details[0].data.truncated,false);
  await writeFile(file,header+JSON.stringify(row("other"))+"\n");
  await assert.rejects(readOmpDetail(batch.items[0].data.detail));
});
test("batch details retain bounded tool bodies and whitelist fields independently of previews",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"omp-details-"));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,"native.jsonl");
  const tool={...row("big","toolResult","x".repeat(300000)),parentId:"parent",providerPayload:{secret:"raw-secret"}};
  Object.assign(tool.message,{toolCallId:"call",toolName:"Bash",isError:true,providerPayload:{secret:"raw-secret"},textSignature:"signature-secret",details:{raw:"raw-secret"}});
  Object.assign(tool.message.content[0],{textSignature:"signature-secret",providerPayload:{secret:"raw-secret"}});
  const call={...row("call"),message:{role:"assistant",content:[{type:"toolCall",id:"c",name:"Read",arguments:{path:"/tmp/example",offset:50},providerPayload:"raw-secret",signature:"signature-secret"}]}};
  await writeFile(file,header+JSON.stringify(tool)+"\n"+JSON.stringify(call)+"\n");
  const first=await readOmpTranscript(file,"native");assert.equal(first.items.length,0);assert.equal(first.details.length,0);
  const batch=await readOmpTranscript(file,"native",first.checkpoint);
  assert.equal(batch.details.length,2);assert.equal(batch.items[0].data.parts[1].text!.length,4000);
  assert.equal(batch.details[0].data.parts[1].text!.length,256*1024);assert.equal(batch.details[0].data.truncated,true);
  assert.equal(batch.details[0].data.parts[0].type,"tool_error");assert.equal(batch.details[0].data.parentId,"parent");
  assert.match(batch.details[1].content,/"offset":50/);assert.doesNotMatch(batch.items[1].content,/offset/);
  assert.equal(batch.details[1].data.truncated,false);assert.equal(batch.items[1].data.truncated,true);
  assert.doesNotMatch(JSON.stringify(batch.details),/raw-secret|signature-secret|providerPayload|textSignature/);
  assert.deepEqual(batch.details[0],await readOmpDetail(batch.items[0].data.detail));
  assert.equal("details" in batch.items[0].data,false);
});
test("part count truncation remains explicit in durable detail",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"omp-parts-"));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,"native.jsonl");
  const entry=row("parts");entry.message.content=Array.from({length:513},()=>({type:"text",text:"part"}));
  await writeFile(file,header+JSON.stringify(entry)+"\n");const batch=await readOmpTranscript(file,"native");
  assert.equal(batch.details[0].data.parts.length,512);assert.equal(batch.details[0].data.truncated,true);assert.equal(batch.checkpoint.skipped,1);
});
test("discovery is narrow and verifies header identity/version before publishing",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"omp-discovery-"));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,"project"));
  const file=join(dir,"project","date_native.jsonl");await writeFile(file,header);
  assert.equal(await discoverOmpTranscript("native",[dir]),file);
  await assert.rejects(readOmpTranscript(file,"other"),/session_mismatch/);
  await writeFile(file,JSON.stringify({type:"session",version:99,id:"native"})+"\n");
  await assert.rejects(readOmpTranscript(file,"native"),/unsupported_version/);
  await writeFile(join(dir,"native.jsonl"),header);
  await assert.rejects(discoverOmpTranscript("native",[dir]),/ambiguous/);
});
