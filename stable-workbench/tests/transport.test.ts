import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachTerminal, type Socket } from '../src/transport.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Wire implements Socket {
  readyState = 1; messages: any[] = [];
  onopen: (() => void) | null = null; onmessage: Socket['onmessage'] = null; onclose: Socket['onclose'] = null; onerror: Socket['onerror'] = null;
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  receive(value: object) { this.onmessage?.({data:JSON.stringify(value)}); }
}
function setup() {
  const sockets: Wire[] = [], writes: {data:string;done:()=>void}[] = []; let resets = 0;
  const client = attachTerminal({url:'ws://test',socket:()=>{const wire=new Wire();sockets.push(wire);return wire;},display:{reset(){resets++;},write(data,done){writes.push({data,done});}},state(){}});
  const hello = (wire=sockets.at(-1)!, instanceId='a') => wire.receive({type:'hello',protocol:2,instanceId,pid:10});
  return {client,sockets,writes,hello,resets:()=>resets};
}
test('ready uses v2 JSON, no resize/snapshot; input waits for full replay application', async t => {
  const f=setup();t.after(()=>f.client.dispose());const wire=f.sockets[0];
  assert.equal(f.client.input('early'),false);f.hello();await tick();
  assert.deepEqual(wire.messages,[{type:'ready',protocol:2,instanceId:'a'}]);
  wire.receive({type:'replay',instanceId:'a',seq:4,data:'history'});await tick();
  assert.equal(f.client.cursor(),null);assert.equal(f.client.input('early'),false);
  f.writes.shift()!.done();await tick();
  assert.deepEqual(f.client.cursor(),{instanceId:'a',seq:4});assert.equal(f.client.input('ok'),true);
  assert.deepEqual(wire.messages.at(-1),{type:'input',data:'ok'});
  assert.equal(f.client.resize(80,24),true);assert.deepEqual(wire.messages.at(-1),{type:'resize',cols:80,rows:24});
});
test('reconnect cursor follows fully applied old in-flight bytes and preserves ordered catchup',async t=>{
  const f=setup();t.after(()=>f.client.dispose());f.hello();await tick();
  f.sockets[0].receive({type:'replay',instanceId:'a',seq:1,data:'old'});await tick();
  f.client.reconnect();f.hello();await tick();assert.equal(f.sockets[1].messages.length,0);
  f.writes.shift()!.done();await tick();assert.equal(f.sockets[1].messages[0].afterSeq,1);
  f.sockets[1].receive({type:'catchup',instanceId:'a',seq:3,data:'delta'});await tick();
  assert.equal(f.client.input('blocked'),false);f.writes.shift()!.done();await tick();
  assert.equal(f.client.cursor()!.seq,3);assert.equal(f.resets(),1);assert.equal(f.client.input('yes'),true);
});
test('sequence gap forces full replay; new instance does not reuse old cursor',async t=>{
  const f=setup();t.after(()=>f.client.dispose());f.hello();await tick();
  f.sockets[0].receive({type:'replay',instanceId:'a',seq:1,data:''});await tick();
  f.sockets[0].receive({type:'output',instanceId:'a',seq:3,data:'gap'});await tick();assert.equal(f.sockets[0].readyState,3);
  f.client.reconnect();f.hello();await tick();assert.equal('afterSeq' in f.sockets[1].messages[0],false);
  f.sockets[1].receive({type:'replay',instanceId:'a',seq:3,data:''});await tick();
  f.client.reconnect();f.hello(f.sockets[2],'b');await tick();assert.equal('afterSeq' in f.sockets[2].messages[0],false);
});
test('refresh starts without a cursor; dispose releases pending parse and old socket cannot enable input',async()=>{
  const f=setup();f.hello();await tick();f.sockets[0].receive({type:'replay',instanceId:'a',seq:1,data:'waiting'});await tick();f.client.dispose();await tick();
  f.writes.shift()!.done();assert.equal(f.client.input('gone'),false);
  const fresh=setup();fresh.hello();await tick();assert.equal('afterSeq' in fresh.sockets[0].messages[0],false);fresh.client.dispose();
});
