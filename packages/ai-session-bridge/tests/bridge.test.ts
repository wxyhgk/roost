import test from "node:test"; import assert from "node:assert/strict"; import {createAiSessionBridge} from "../src/index.ts";
test("bind, deduplicate and replay",()=>{const b=createAiSessionBridge({maxEvents:2}); b.bind({webSessionId:"w",terminalInstanceId:"i",cliId:"claude",nativeSessionId:"n"}); assert.ok(b.publish("w",{eventId:"1",type:"message",content:"a"})); assert.equal(b.publish("w",{eventId:"1",type:"message"}),null); b.publish("w",{eventId:"2",type:"message"}); b.publish("w",{eventId:"3",type:"message"}); assert.equal(b.read("w",0).hasGap,true);});

const input = (id: string) => ({ webSessionId: id, terminalInstanceId: "instance", cliId: "claude", nativeSessionId: id });
test("restored metadata stays lazy until replay is needed and archive receives events before cache trimming", () => {
  const original=createAiSessionBridge(); const binding=original.bind(input("lazy"));
  const retained=original.publish("lazy",{eventId:"old",type:"message",content:"old"})!;
  let loads=0;
  const saves: import('../src/index.ts').BridgeSaveChanges[]=[];
  const bridge=createAiSessionBridge({maxEvents:1,storage:{
    list:()=>[{binding,cursor:1,droppedThrough:0,events:[],hasSeenMessages:true}],
    loadEvents:(id,generation,cursor)=>{loads++;assert.equal(id,'lazy');assert.equal(generation,binding.generation);assert.equal(cursor,1);return [retained];},
    save:(_record,_revision,changes)=>{if(changes)saves.push(changes);},remove:()=>{},
  }});
  bridge.list();bridge.get('lazy');bridge.source('lazy');bridge.transcript('lazy');
  assert.equal(loads,0);
  assert.equal(bridge.read('lazy').events[0].event.content,'old');assert.equal(loads,1);
  bridge.publish('lazy',{eventId:'new',type:'message',content:'new'});
  assert.deepEqual(saves[0].events?.map(event=>event.event.eventId),['new']);
  assert.deepEqual(bridge.read('lazy').events.map(event=>event.event.eventId),['new']);
  assert.equal(loads,1);
});
test("legacy retained messages remain identity evidence after state events evict them", () => {
  const original=createAiSessionBridge(); const binding=original.bind(input("legacy"));
  const event=original.publish("legacy",{eventId:"message",type:"message"})!;
  const bridge=createAiSessionBridge({maxEvents:1,storage:{list:()=>[{binding,cursor:1,droppedThrough:0,events:[event]}],save:()=>{},remove:()=>{}}});
  bridge.publish("legacy",{eventId:"state",type:"turn-state",state:"completed"});
  assert.equal(bridge.read("legacy").events.some(item=>item.event.type==="message"),false);
  assert.equal(bridge.source("legacy").hasMessages,true);
});
test("sessions have independent cursors, immutable snapshots and idempotent bindings", () => {
  const bridge = createAiSessionBridge();
  const first = bridge.bind(input("a")); bridge.bind(input("b"));
  assert.deepEqual(bridge.bind(input("a")), first);
  bridge.publish("a", { eventId: "1", type: "message" });
  assert.equal(bridge.read("b").cursor, 0);
  bridge.publish("b", { eventId: "1", type: "turn-state", state: "running" });
  assert.equal(bridge.read("b").hasGap, false);
  assert.equal(bridge.get("b")?.state, "running");
  first.nativeSessionId = "corrupted";
  assert.equal(bridge.get("a")?.nativeSessionId, "a");
  assert.throws(() => bridge.bind({ ...input("a"), cliId: "codex" }), /already bound/);
  assert.throws(() => bridge.read("a", 2), /cursor/);
});
test("storage failure does not advance cursor or notify subscribers", () => {
  let fail = false;
  const bridge = createAiSessionBridge({ storage: { list: () => [], remove: () => {}, save: () => { if (fail) throw new Error("disk full"); } } });
  bridge.bind(input("a")); let delivered = 0;
  bridge.subscribe("a", () => delivered++); fail = true;
  assert.throws(() => bridge.publish("a", { eventId: "1", type: "message" }), /disk full/);
  assert.equal(bridge.read("a").cursor, 0); assert.equal(delivered, 0);
});
test("subscriber errors and mutations cannot corrupt stored events or other consumers", () => {
  const bridge = createAiSessionBridge(); bridge.bind(input("a"));
  bridge.subscribe("a", event => { event.event.content = "changed"; throw new Error("subscriber failed"); });
  let content: string | undefined;
  bridge.subscribe("a", event => { content = event.event.content; });
  bridge.publish("a", { eventId: "1", type: "message", content: "original" });
  assert.equal(content, "original"); assert.equal(bridge.read("a").events[0].event.content, "original");
});

test("source checkpoint survives event eviction and generations reject stale cursors", () => {
  const bridge=createAiSessionBridge({maxEvents:1});
  bridge.bind(input("a"));
  bridge.publish("a",{eventId:"source:1",type:"message"},{cursor:1,hasGap:false});
  bridge.publish("a",{eventId:"source:2",type:"message"},{cursor:2,hasGap:false});
  assert.equal(bridge.publish("a",{eventId:"source:1",type:"message"},{cursor:1,hasGap:false}),null);
  const old=bridge.get("a")!;
  const next=bridge.rebind({...input("a"),nativeSessionId:"new"},old.generation,old.revision);
  assert.notEqual(next.generation,old.generation);
  assert.throws(()=>bridge.read("a",0,old.generation),/generation/);
  assert.throws(()=>bridge.rebind(input("a"),old.generation,old.revision),/version/);
  assert.equal(bridge.read("a").cursor,0);
});
