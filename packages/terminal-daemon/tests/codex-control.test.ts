import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, {WebSocketServer} from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexControl, codexAcceptedUserItem, CodexControlError } from '../src/codex-control.ts';
const id = '019a0000-0000-7000-a000-000000000001';
async function fixture(t: any, handle: (row: any, socket: WebSocket) => unknown) {
  const root = await mkdtemp(join(tmpdir(), 'codex-control-'));
  const socketPath = join(root, 'server.sock'), calls: any[] = [], sockets = new Set<WebSocket>();
  const server = createServer();
  const wss = new WebSocketServer({server});
  wss.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', chunk => {
        const row = JSON.parse(chunk.toString()); calls.push(row);
        if (row.method === 'initialized') return;
        const result = row.method === 'initialize' ? {} : handle(row,socket);
        if (result !== undefined) socket.send(JSON.stringify({id:row.id,result}));
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root,{recursive:true,force:true}); });
  return {socketPath,calls};
}
const thread = (status = 'active') => ({thread:{id,path:'/explicit/rollout.jsonl',status:{type:status}}});
test('queues exact text to the existing active thread without starting, steering or PTY input', async t => {
  const f = await fixture(t, row => row.method === 'thread/read' ? thread() : {queuedSubmission:{id:'queue1',clientUserMessageId:row.params.clientUserMessageId,input:row.params.input}});
  const control = createCodexControl({socketPath:f.socketPath,threadId:id}); t.after(()=>control.close());
  const receipt = await control.enqueue('request1','化学\nnext');
  assert.deepEqual(receipt,{status:'native_queued',threadId:id,requestId:'request1',queuedSubmissionId:'queue1'});
  assert.deepEqual(f.calls.map(c=>c.method),['initialize','initialized','thread/read','thread/queue/add']);
  assert.equal(f.calls[2].params.includeTurns,false);
  assert.deepEqual(f.calls[3].params.input,[{type:'text',text:'化学\nnext',text_elements:[]}]);
});
test('wrong identity and unloaded threads fail before queue mutation', async t => {
  for (const result of [{thread:{...thread().thread,id:'other'}},thread('notLoaded')]) {
    const f=await fixture(t,()=>result); const c=createCodexControl({socketPath:f.socketPath,threadId:id});
    await assert.rejects(c.enqueue('r','text'),/thread_mismatch|thread_not_loaded/); c.close();
    assert.ok(!f.calls.some(row=>row.method==='thread/queue/add'));
  }
});
test('write followed by disconnect is uncertain and never retried', async t => {
  const f=await fixture(t,(row,socket)=>{if(row.method==='thread/read')return thread();socket.terminate();});
  const c=createCodexControl({socketPath:f.socketPath,threadId:id}); t.after(()=>c.close());
  await assert.rejects(c.enqueue('r','text'),(error:any)=>error instanceof CodexControlError && error.uncertain);
  await assert.rejects(c.enqueue('r','text'),/control_disconnected/);
  assert.equal(f.calls.filter(row=>row.method==='thread/queue/add').length,1);
});
test('rejects invalid and mismatching native receipts, without exposing server data', async t => {
  const f=await fixture(t,row=>row.method==='thread/read'?thread():{queuedSubmission:{id:'q',clientUserMessageId:'someone-else',input:[]}});
  const c=createCodexControl({socketPath:f.socketPath,threadId:id});t.after(()=>c.close());
  await assert.rejects(c.enqueue('r','/exit'),/invalid_request/);
  await assert.rejects(c.enqueue('r','x'.repeat(16385)),/invalid_request/);
  await assert.rejects(c.enqueue('r','text'),(e:any)=>e.code==='invalid_receipt'&&e.uncertain);
});
test('acceptance needs exact thread + request + native user item, queue receipt is insufficient',()=>{
  const expected={threadId:id,requestId:'r',text:'text'};
  const note={method:'item/completed',params:{threadId:id,item:{type:'userMessage',id:'native-user-1',clientId:'r',content:[{type:'text',text:'text'}]}}};
  assert.equal(codexAcceptedUserItem(note,expected),'native-user-1');
  assert.equal(codexAcceptedUserItem({...note,method:'thread/queue/add'},expected),null);
  assert.equal(codexAcceptedUserItem(note,{...expected,threadId:'other'}),null);
  assert.equal(codexAcceptedUserItem(note,{...expected,requestId:'other'}),null);
  assert.equal(codexAcceptedUserItem(note,{...expected,text:'other'}),null);
});
test('timeout is bounded and approval requests never produce responses', async t=>{
  const f=await fixture(t,(row,socket)=>{if(row.method==='thread/read')return thread();socket.send(JSON.stringify({id:123,method:'item/commandExecution/requestApproval',params:{}}));});
  const c=createCodexControl({socketPath:f.socketPath,threadId:id,timeoutMs:50});t.after(()=>c.close());
  await assert.rejects(c.enqueue('r','text'),(e:any)=>e.code==='control_timeout'&&e.uncertain);
  assert.equal(f.calls.length,4);
});

test('installed Codex native queue protocol, isolated home and non-network model endpoint', {skip:process.env.ROOST_VERIFY_CODEX_CONTROL !== '1'}, async t=>{
  const {spawn}=await import('node:child_process');
  const {connect}=await import('node:net');
  const {stat}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'codex-native-control-'));
  const socketPath=join(root,'native.sock');
  const env={...process.env,CODEX_HOME:root};
  delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL; delete env.CODEX_API_KEY;
  const child=spawn('codex',['app-server','--listen',`unix://${socketPath}`,'-c','model_provider="probe"','-c','model_providers.probe.name="Probe"','-c','model_providers.probe.base_url="http://127.0.0.1:1/v1"','-c','model_providers.probe.wire_api="responses"'],{env,stdio:['pipe','ignore','pipe']});
  child.stderr?.resume();
  let control:ReturnType<typeof createCodexControl>|undefined;
  let bootstrap:WebSocket|undefined;
  t.after(async()=>{control?.close();bootstrap?.terminate();if(child.exitCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),1000);await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);}await rm(root,{recursive:true,force:true});});
  const start=Date.now();
  while(!await stat(socketPath).then(()=>true,()=>false)){if(Date.now()-start>5000)throw Error('native socket unavailable');await new Promise(resolve=>setTimeout(resolve,20));}
  bootstrap=new WebSocket('ws://localhost/',{createConnection:()=>connect(socketPath),perMessageDeflate:false});
  await new Promise<void>((resolve,reject)=>{bootstrap!.once('open',resolve);bootstrap!.once('error',reject);});
  let seq=1;const pending=new Map<number,(row:any)=>void>();
  bootstrap.on('message',chunk=>{const row=JSON.parse(chunk.toString());const done=pending.get(row.id);if(done){pending.delete(row.id);done(row);}});
  async function rpc(method:string,params:unknown):Promise<any>{return new Promise((resolve,reject)=>{const id=seq++;const timer=setTimeout(()=>reject(Error('native rpc timeout')),5000);pending.set(id,row=>{clearTimeout(timer);row.error?reject(Error('native rpc rejected')):resolve(row.result);});bootstrap!.send(JSON.stringify({id,method,params}));});}
  await rpc('initialize',{clientInfo:{name:'roost_native_fixture',version:'0.1'},capabilities:{experimentalApi:true}});
  bootstrap.send(JSON.stringify({method:'initialized'}));
  // Only the isolated test harness creates a synthetic thread. Production adapter
  // must attach to an explicitly proven existing TUI thread, never create one.
  const started=await rpc('thread/start',{cwd:root,modelProvider:'probe',model:'probe'});
  control=createCodexControl({socketPath,threadId:started.thread.id});
  assert.equal((await control.inspect()).threadId,started.thread.id);
  const receipt=await control.enqueue('native-probe-request','isolated synthetic fixture');
  assert.equal(receipt.status,'native_queued');assert.equal(receipt.threadId,started.thread.id);assert.ok(receipt.queuedSubmissionId);
});
