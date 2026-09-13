import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "../src/store.ts";
import { DatabaseSync } from "node:sqlite";
import { createAiSessionStorage } from "../src/ai-sessions.ts";
import { createAiSessionBridge, type BridgeRecord } from "@roost/ai-session-bridge";

function fixture(maxEvents=2) {
  const db=new DatabaseSync(":memory:"),storage=createAiSessionStorage(db),bridge=createAiSessionBridge({storage,maxEvents});
  const binding=bridge.bind({webSessionId:"web",cliId:"omp",nativeSessionId:"a",terminalInstanceId:"i"});
  return {db,storage,bridge,binding};
}
test("history survives replay eviction, lazy reopen and fixed upper-bound pagination during append",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    for(let i=1;i<=6;i++)bridge.publish("web",{eventId:`e${i}`,type:"message",content:`body ${i}`});
    assert.equal(storage.list()[0]!.events.length,0);
    assert.equal(storage.loadEvents!("web",binding.generation,6).length,2);
    const page=storage.history!.pageMessages("web",binding.generation,{limit:2});
    assert.deepEqual(page.items.map(e=>e.historySeq),[5,6]);assert.equal(page.upperBoundSeq,6);
    bridge.publish("web",{eventId:"e7",type:"message",content:"append"});
    const second=storage.history!.pageMessages("web",binding.generation,{cursor:page.nextCursor!,limit:2});
    assert.deepEqual(second.items.map(e=>e.historySeq),[3,4]);assert.equal(second.upperBoundSeq,6);
    const restored=createAiSessionBridge({storage});assert.equal(restored.source("web").hasMessages,true);assert.equal(restored.read("web").events.length,2);
    assert.equal(storage.history!.getMessage("web",binding.generation,"e1").event.content,"body 1");
    assert.throws(()=>storage.history!.pageMessages("missing",binding.generation),/not found/);
    assert.throws(()=>storage.history!.pageMessages("web",binding.generation,{cursor:"broken"}),/cursor/);
  }finally{db.close();}
});
test("A to B to A archives generations, shares bodies and freezes old upper bound",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"a1",type:"message",content:"A"});
    let current=bridge.get("web")!;
    bridge.rebind({...current,nativeSessionId:"b"},current.generation,current.revision);
    bridge.publish("web",{eventId:"b1",type:"message",content:"B"});
    current=bridge.get("web")!;
    const latest=bridge.rebind({...current,nativeSessionId:"a"},current.generation,current.revision);
    bridge.publish("web",{eventId:"a1",type:"message",content:"A"});
    bridge.publish("web",{eventId:"a2",type:"message",content:"A new"});
    const gens=storage.history!.listGenerations("web").items;
    assert.equal(gens.length,3);assert.equal(gens[0]!.conversationId,gens[2]!.conversationId);
    assert.equal(storage.history!.pageMessages("web",binding.generation).items.length,1);
    assert.equal(storage.history!.pageMessages("web",latest.generation).items.length,2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_history_messages").get() as {n:number}).n,3);
    storage.remove("web");
    assert.equal(storage.list().length,0,"live binding is removed");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_history_bodies").get() as {n:number}).n,3,"last terminal removal retains durable histories");
    assert.equal(storage.history!.getMessage("web",binding.generation,"a1").event.content,"A");
    assert.equal(storage.history!.pageMessages("web",latest.generation).items.length,2);
  }finally{db.close();}
});
test("save failures roll metadata, replay and bodies back; source revisions expire cursors",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"one",type:"message",content:"one"});
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON ai_history_messages BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(()=>bridge.publish("web",{eventId:"two",type:"message",content:"two"}),/injected/);
    assert.equal(storage.list()[0]!.cursor,1);assert.equal(bridge.read("web").cursor,1);
    assert.equal(storage.history!.pageMessages("web",binding.generation).items.length,1);
    db.exec("DROP TRIGGER fail_history");bridge.publish("web",{eventId:"two",type:"message",content:"two"});
    const page=storage.history!.pageMessages("web",binding.generation,{limit:1});
    const record=storage.list()[0]!;record.events=storage.loadEvents!("web",binding.generation,record.cursor);const expected=record.binding.revision;record.binding.revision++;
    storage.save(record,expected,{details:[{eventId:"one",type:"message",content:"corrected"}]});
    assert.throws(()=>storage.history!.pageMessages("web",binding.generation,{cursor:page.nextCursor!}),/revised/);
    assert.equal(storage.history!.getMessage("web",binding.generation,"one").event.content,"one");
    const revised=storage.history!.pageMessages("web",binding.generation).items.at(-1)!;
    assert.equal(storage.history!.getMessage("web",binding.generation,revised.messageId).event.content,"corrected");
    assert.equal(revised.sourceRevision,2);
    assert.throws(()=>storage.save(record,expected),/concurrent/);
  }finally{db.close();}
});
test("legacy migration is idempotent, marks lost window and rejects obsolete writers",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE ai_session_records(session_id TEXT PRIMARY KEY,record_json TEXT NOT NULL)");
    const binding={webSessionId:"old",generation:"g",revision:3,terminalInstanceId:"i",cliId:"omp",nativeSessionId:"old",state:"ready" as const,updatedAt:1};
    const event={eventId:"legacy",type:"message" as const,content:"preview",data:{detail:{path:"/does/not/exist"},truncated:true}};
    const record:BridgeRecord={binding,cursor:3,droppedThrough:2,events:[{generation:"g",seq:3,binding,event}]};
    db.prepare("INSERT INTO ai_session_records VALUES(?,?)").run("old",JSON.stringify(record));
    let storage=createAiSessionStorage(db);
    assert.deepEqual(JSON.parse((db.prepare("SELECT record_json FROM ai_history_legacy_records").get() as {record_json:string}).record_json),record);
    assert.equal(storage.list()[0]!.events.length,0);assert.equal(storage.list()[0]!.hasSeenMessages,true);
    assert.equal(storage.history!.pageMessages("old","g").coverage.hasGap,true);
    assert.equal(storage.history!.getMessage("old","g","legacy").bodyState,"source_backed");
    storage=createAiSessionStorage(db);assert.equal(storage.history!.pageMessages("old","g").items.length,1);
    assert.throws(()=>db.prepare("UPDATE ai_session_records SET record_json=?").run(JSON.stringify(record)),/upgraded gateway/);
  }finally{db.close();}
});
test("list remains metadata-only with 100000 messages; previews obey response budget",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"large",type:"message",content:"中".repeat(300000)});
    const cid=storage.history!.listGenerations("web").items[0]!.conversationId;
    db.exec("BEGIN");const insert=db.prepare("INSERT INTO ai_history_messages VALUES(?,?,?,?,?,1,?,?)");
    for(let i=2;i<=100000;i++)insert.run(cid,`e${i}`,i,JSON.stringify({eventId:`e${i}`,type:"message",content:"small"}),"stored",`e${i}`,`hash${i}`);
    db.prepare("UPDATE ai_conversations SET last_seq=100000 WHERE id=?").run(cid);db.exec("COMMIT");
    const list=storage.list();assert.equal(list.length,1);assert.equal(list[0]!.events.length,0);assert.ok(JSON.stringify(list).length<4096);
    const page=storage.history!.pageMessages("web",binding.generation);assert.equal(page.items.length,50);assert.equal(page.items.at(-1)!.historySeq,100000);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<512*1024);
    assert.equal(storage.history!.getMessage("web",binding.generation,"large").event.content?.length,300000);
  }finally{db.close();}
});
test("archived generation bodies stay immutable when native IDs are reused with revised content",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"same",type:"message",content:"original"});
    let b=bridge.get("web")!;bridge.rebind({...b,nativeSessionId:"b"},b.generation,b.revision);
    b=bridge.get("web")!;const latest=bridge.rebind({...b,nativeSessionId:"a"},b.generation,b.revision);
    bridge.publish("web",{eventId:"same",type:"message",content:"revision"});
    assert.equal(storage.history!.getMessage("web",binding.generation,"same").event.content,"original");
    const old=storage.history!.pageMessages("web",binding.generation);assert.equal(old.items.length,1);
    const now=storage.history!.pageMessages("web",latest.generation);assert.equal(now.items.length,2);assert.equal(now.items[1]!.sourceRevision,2);
    assert.equal(storage.history!.getMessage("web",latest.generation,now.items[1]!.messageId).event.content,"revision");
    assert.throws(()=>storage.history!.getMessage("web",binding.generation,now.items[1]!.messageId),/not found/);
  }finally{db.close();}
});
test("full-body enrichment keeps one row and a new source location is not a revision",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    const preview={eventId:"tool",type:"message" as const,content:"short",data:{truncated:true,detail:{path:"/gone",offset:0,hash:"same-line"}}};
    bridge.publish("web",preview);
    let r=storage.list()[0]!;r.events=storage.loadEvents!("web",binding.generation,r.cursor);let expected=r.binding.revision;r.binding.revision++;
    const full={...preview,content:"full durable body",data:{truncated:false,detail:{path:"/gone",offset:0,hash:"same-line"}}};
    storage.save(r,expected,{details:[full]});
    assert.equal(storage.history!.pageMessages("web",binding.generation).items.length,1);
    assert.equal(storage.history!.getMessage("web",binding.generation,"tool").bodyState,"stored");
    r=storage.list()[0]!;r.events=storage.loadEvents!("web",binding.generation,r.cursor);expected=r.binding.revision;r.binding.revision++;
    storage.save(r,expected,{details:[{...full,createdAt:1234,data:{truncated:false,detail:{path:"/different",offset:100,hash:"same-line"}}}]});
    assert.equal(storage.history!.pageMessages("web",binding.generation).items.length,1);
    const raw=JSON.parse((db.prepare("SELECT record_json FROM ai_session_records").get() as {record_json:string}).record_json);
    assert.equal(raw.events,undefined);assert.throws(()=>{for(const _ of raw.events){}},TypeError);
    assert.equal((storage.list()[0] as unknown as {storageFormat?:number}).storageFormat,undefined);
  }finally{db.close();}
});
test("removing a web session preserves a conversation referenced by another generation",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"kept",type:"message",content:"shared"});
    const b=bridge.get("web")!;bridge.rebind({...b,nativeSessionId:"b"},b.generation,b.revision);
    const other=bridge.bind({webSessionId:"other",nativeSessionId:"a",cliId:"omp",terminalInstanceId:"j"});
    storage.remove("web");assert.equal(storage.history!.getMessage("other",other.generation,"kept").event.content,"shared");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get() as {n:number}).n,2,"both native histories survive removal of their terminal references");
    storage.remove("other");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_history_bodies").get() as {n:number}).n,1);
    assert.equal(storage.history!.getMessage("other",other.generation,"kept").event.content,"shared");
  }finally{db.close();}
});
test("workspace delete is atomic across sessions, journal, replay and durable history",()=>{
  const dir=mkdtempSync(join(tmpdir(),"ai-history-delete-")),store=createWorkspaceStore({dataDir:dir}),db=new DatabaseSync(join(dir,"workspace.sqlite"));
  try {
    store.upsertSession({id:"web",cwd:"/tmp"});store.setPinnedSessionIds(["web"]);
    store.agentJournal.append("web","instance",{event:"session_start"});
    db.prepare("INSERT INTO terminal_replay(session_id,raw,updated_at) VALUES(?,?,?)").run("web","screen",1);
    const bridge=createAiSessionBridge({storage:store.aiSessions});
    const b=bridge.bind({webSessionId:"web",cliId:"omp",nativeSessionId:"a",terminalInstanceId:"i"});
    bridge.publish("web",{eventId:"body",type:"message",content:"saved"});
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'delete injected'); END");
    assert.throws(()=>store.deleteSessionRecord("web"),/delete injected/);
    for(const table of ["sessions","agent_journal_heads","agent_journal_events","terminal_replay","ai_session_records","ai_session_replay","ai_generations","ai_history_messages","ai_history_bodies"])
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,1,table);
    assert.deepEqual(store.loadWorkspace().pinnedSessionIds,["web"]);
    assert.equal(store.aiSessions.history!.getMessage("web",b.generation,"body").event.content,"saved");
    db.exec("DROP TRIGGER fail_delete");store.deleteSessionRecord("web");
    for(const table of ["sessions","agent_journal_heads","agent_journal_events","terminal_replay","ai_session_records","ai_session_replay"])
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,0,table);
    for(const table of ["ai_generations","ai_history_messages","ai_history_bodies","conversation_catalog","conversation_sources"])
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,1,table+" remains independently owned");
    assert.equal(store.aiSessions.history!.getMessage("web",b.generation,"body").event.content,"saved");
    assert.deepEqual(store.loadWorkspace().pinnedSessionIds,[]);
  }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test("intermediate history schema upgrades before creating new indexes",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE ai_history_messages(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,preview_json TEXT NOT NULL,body_state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(conversation_id,message_id),UNIQUE(conversation_id,seq))");
    db.prepare("INSERT INTO ai_history_messages VALUES('c','m',1,?,'stored',1)").run(JSON.stringify({eventId:"native",type:"message",content:"retained"}));
    createAiSessionStorage(db);createAiSessionStorage(db);
    const row=db.prepare("SELECT event_id,content_hash FROM ai_history_messages").get() as {event_id:string;content_hash:string};
    assert.equal(row.event_id,"native");assert.equal(row.content_hash.length,64);
  }finally{db.close();}
});
test("deduplicated transcript batches persist revised previews alongside full bodies",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    bridge.publish("web",{eventId:"native",type:"message",content:"old preview"});
    const record=storage.list()[0]!;record.events=storage.loadEvents!("web",binding.generation,record.cursor);const expected=record.binding.revision;record.binding.revision++;
    storage.save(record,expected,{messages:[{eventId:"native",type:"message",content:"new preview",data:{truncated:true}}],details:[{eventId:"native",type:"message",content:"new full body"}]});
    const page=storage.history!.pageMessages("web",binding.generation);assert.equal(page.items.at(-1)!.event.content,"new preview");
    assert.equal(storage.history!.getMessage("web",binding.generation,page.items.at(-1)!.messageId).event.content,"new full body");
  }finally{db.close();}
});

test("long Unicode session IDs and oversized optional metadata cannot break bounded pagination",()=>{
  const {db,storage,bridge}=fixture();
  try {
    const id="中".repeat(512);
    const b=bridge.bind({webSessionId:id,terminalInstanceId:"unicode",cliId:"omp",nativeSessionId:"unicode"});
    bridge.publish(id,{eventId:"first",type:"message",content:"first"});
    bridge.publish(id,{eventId:"large-role",type:"message",role:"x".repeat(700000),content:"second"});
    const page=storage.history!.pageMessages(id,b.generation,{limit:1});
    assert.equal(page.items.length,1);assert.equal(page.hasMore,true);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<512*1024);
    assert.ok(page.nextCursor!.length<2048);
    const earlier=storage.history!.pageMessages(id,b.generation,{limit:1,cursor:page.nextCursor!});
    assert.equal(earlier.items[0]!.event.content,"first");assert.equal(earlier.hasMore,false);
  }finally{db.close();}
});

test("matching truncated previews cannot attach a changed source body to an old archive record",()=>{
  const {db,storage,bridge,binding}=fixture();
  try {
    const preview={eventId:"partial",type:"message" as const,content:"same prefix",data:{truncated:true,detail:{hash:"original-line"}}};
    bridge.publish("web",preview);
    const r=storage.list()[0]!;r.events=storage.loadEvents!("web",binding.generation,r.cursor);
    const expected=r.binding.revision;r.binding.revision++;
    storage.save(r,expected,{messages:[{...preview,data:{truncated:true,detail:{hash:"changed-line"}}}],details:[{...preview,content:"same prefix, different remainder",data:{truncated:false,detail:{hash:"changed-line"}}}]});
    const old=storage.history!.getMessage("web",binding.generation,"partial");
    assert.equal(old.event.content,"same prefix");assert.equal(old.bodyState,"source_backed");
    const rows=storage.history!.pageMessages("web",binding.generation).items;
    assert.equal(rows.length,2);
    assert.equal(storage.history!.getMessage("web",binding.generation,rows[1]!.messageId).event.content,"same prefix, different remainder");
  }finally{db.close();}
});

test("rebind retries remain idempotent after new messages and bridge recreation",()=>{
  const {db,storage,bridge}=fixture();
  try {
    bridge.publish("web",{eventId:"old",type:"message",content:"old conversation"});
    const before=bridge.get("web")!;
    const input={...before,nativeSessionId:"next"};
    const next=bridge.rebind(input,before.generation,before.revision,3);
    bridge.publish("web",{eventId:"new",type:"message",content:"new conversation"});
    const restored=createAiSessionBridge({storage});
    const retried=restored.rebind(input,before.generation,before.revision,3);
    assert.equal(retried.generation,next.generation);
    assert.equal(storage.history!.listGenerations("web").items.length,2);
    assert.equal(restored.read("web").events[0]!.event.content,"new conversation");
    const same=restored.rebind(input,retried.generation,retried.revision,3);
    assert.equal(same.generation,next.generation);
    assert.throws(()=>restored.rebind({...input,nativeSessionId:"different"},before.generation,before.revision),/version/);
  }finally{db.close();}
});
