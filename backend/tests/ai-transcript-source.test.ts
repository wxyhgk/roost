import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, realpath } from "node:fs/promises";
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

/*
  记下来的路径失效之后，按原生会话 id 重新找回来。

  **这是「永久坏掉且不报错」和「文件动了会自己好」的分界。** 路径里夹着一段按 cwd 派生的
  目录名，仓库改个名、挪个位置那一段就对不上了；实测这台机器 18 条有路径的对话里 4 条
  已经指向不存在的文件，其中一条正是这个仓库自己（还指着改名前的目录名）。
*/
test("记下的转录路径失效时，按会话 id 重新发现，而不是一直 ENOENT 下去", async t => {
  const dir = await mkdtemp(join(tmpdir(), "transcript-restale-")); t.after(() => rm(dir, {recursive: true, force: true}));
  // 模拟「目录改名」：文件在 after 这一层，而绑定里记的是 before 那一层。
  const before = join(dir, "before"), after = join(dir, "after");
  await mkdir(after, {recursive: true});
  const moved = join(after, "native.jsonl");
  await writeFile(moved, header + message("u", "user", "还在的内容"));

  const store = createWorkspaceStore({dataDir: join(dir, "db")}); t.after(() => store.close());
  const bridge = createAiSessionBridge({storage: store.aiSessions});
  bridge.bind({webSessionId: "s", terminalInstanceId: "i", cliId: "omp", nativeSessionId: "native",
    transcriptPath: join(before, "native.jsonl")});
  const source = createAiTranscriptSource(bridge, [dir]); t.after(() => source.dispose());

  await source.catchUp("s");
  const items = store.aiSessions.history!.pageMessages("s", bridge.get("s")!.generation).items;
  assert.equal(items.length, 1, "路径失效不该让这条对话读不出内容");
  assert.equal(items[0]!.event.content, "还在的内容");
});

test("记下的路径还在时就用它，不做多余的发现", async t => {
  /*
    只测「失效时能找回来」是不够的：把判断写反（永远走发现）在单根目录下也能过，
    而那会让每一轮都多扫一遍整棵目录树。这里给两个同名会话制造歧义——真去发现就会
    抛 `ambiguous_transcript`，用记下的那条则照常。
  */
  const dir = await mkdtemp(join(tmpdir(), "transcript-declared-")); t.after(() => rm(dir, {recursive: true, force: true}));
  const one = join(dir, "one"), two = join(dir, "two");
  await mkdir(one, {recursive: true}); await mkdir(two, {recursive: true});
  const chosen = join(one, "native.jsonl");
  await writeFile(chosen, header + message("u", "user", "记下的那一份"));
  await writeFile(join(two, "native.jsonl"), header + message("u", "user", "另一份同名的"));

  const store = createWorkspaceStore({dataDir: join(dir, "db")}); t.after(() => store.close());
  const bridge = createAiSessionBridge({storage: store.aiSessions});
  bridge.bind({webSessionId: "s", terminalInstanceId: "i", cliId: "omp", nativeSessionId: "native", transcriptPath: chosen});
  const source = createAiTranscriptSource(bridge, [dir]); t.after(() => source.dispose());

  await source.catchUp("s");
  const items = store.aiSessions.history!.pageMessages("s", bridge.get("s")!.generation).items;
  assert.equal(items[0]!.event.content, "记下的那一份");
});

test("claude 也能按会话 id 发现转录——原来只有 omp/qwen 有这条退路", async t => {
  /*
    claude 落盘是 `<根>/<按 cwd 派生的一层>/<会话id>.jsonl`，和 omp 同构，所以共用
    `discoverTranscriptById`。原来 claude 走的是「没有路径就直接报
    explicit_source_required」，于是路径一失效这条对话就再也读不到新内容。
  */
  const dir = await mkdtemp(join(tmpdir(), "transcript-claude-")); t.after(() => rm(dir, {recursive: true, force: true}));
  const projects = join(dir, "projects"), slug = join(projects, "-Users-someone-Code-thing");
  await mkdir(slug, {recursive: true});
  await writeFile(join(slug, "claude-native.jsonl"),
    JSON.stringify({type: "user", sessionId: "claude-native", uuid: "u1", message: {role: "user", content: "第一句"}}) + "\n");

  const store = createWorkspaceStore({dataDir: join(dir, "db")}); t.after(() => store.close());
  const bridge = createAiSessionBridge({storage: store.aiSessions});
  // 不给 transcriptPath：这正是原来 claude 直接失败的那一格。
  bridge.bind({webSessionId: "s", terminalInstanceId: "i", cliId: "claude", nativeSessionId: "claude-native"});
  const source = createAiTranscriptSource(bridge, [dir], [dir], [projects]); t.after(() => source.dispose());

  await source.catchUp("s");
  /*
    断言**正文真的进来了**，而不是「状态不是 failed」——那种写法太松：把 claude 的发现
    整条删掉之后状态是 undefined 而不是 failed，用例照样绿（变异测试当场抓到）。
  */
  const items = store.aiSessions.history!.pageMessages("s", bridge.get("s")!.generation).items;
  assert.equal(items.length, 1, `应当读到 1 条，实际 ${items.length}；路径 ${bridge.get("s")?.transcriptPath}`);
  assert.equal(items[0]!.event.content, "第一句");
});
