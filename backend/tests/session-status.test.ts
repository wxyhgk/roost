import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { latestPty } from './helpers/fake-pty.ts';
import type { TerminalService } from '@roost/terminal-runtime';
const {createWorkspaceStore}=await import('@roost/workspace-store');
const {createTerminalRuntime}=await import('@roost/terminal-runtime');
const {createSessionStatus}=await import('../src/session-status.ts');
const {createBackendServer}=await import('../src/server.ts');
function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'roost-session-status-'));
  const store=createWorkspaceStore({dataDir:dir});
  const runtime:TerminalService=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  t.after(()=>{runtime.dispose();store.close();rmSync(dir,{recursive:true,force:true})});
  return {dir,store,runtime};
}

test('unmounted terminals report output activity, silence, exits and closed states without inferring AI completion',async t=>{
  const {dir,store,runtime}=fixture(t);
  let time=10000;
  const record=store.upsertSession({cwd:dir});
  const tracker=createSessionStatus(store,runtime,()=>time);t.after(()=>tracker.dispose());
  assert.equal(tracker.snapshot().sessions[0].state,'exited');
  await runtime.ensureSession(record.id,dir);
  assert.equal(tracker.snapshot().sessions[0].state,'quiet');
  latestPty().emitData('private output that must never be in status');
  const active=tracker.snapshot();
  assert.equal(active.sessions[0].state,'active');assert.equal(active.sessions[0].lastOutputAt,time);
  assert.ok(active.sessions[0].outputSeq!>0);assert.ok(!JSON.stringify(active).includes('private output'));
  const seq=active.sessions[0].outputSeq;
  const revision=active.revision;
  assert.equal(tracker.snapshot().revision,revision);
  time+=3001;
  const quiet=tracker.snapshot().sessions[0];assert.equal(quiet.state,'quiet');assert.equal(quiet.outputSeq,seq);
  latestPty().emitData('\x1b[2J');assert.equal(tracker.snapshot().sessions[0].state,'active','TUI redraws are activity, not proof of generation');
  latestPty().emitExit();assert.equal(tracker.snapshot().sessions[0].state,'exited');
  store.setSessionClosed(record.id,true);assert.equal(tracker.snapshot().sessions[0].state,'closed');
});

test('instance replacement resets cursor, daemon disconnection is unavailable, deletion removes subscription',async t=>{
  const {dir,store,runtime}=fixture(t);
  const record=store.upsertSession({cwd:dir});
  const tracker=createSessionStatus(store,runtime);t.after(()=>tracker.dispose());
  const first=await runtime.ensureSession(record.id,dir);latestPty().emitData('one');
  const before=tracker.snapshot();assert.equal(before.sessions[0].state,'active');
  await runtime.killSession(record.id);const second=await runtime.ensureSession(record.id,dir);
  assert.notEqual(first.instanceId,second.instanceId);
  assert.equal(tracker.snapshot().sessions[0].outputSeq,null);
  runtime.isConnected=()=>false;
  assert.equal(tracker.snapshot().sessions[0].state,'unavailable');
  runtime.isConnected=()=>true;
  assert.equal(tracker.snapshot().sessions[0].state,'quiet');
  store.deleteSessionRecord(record.id);assert.equal(tracker.snapshot().sessions.length,0);
  latestPty().emitData('deleted output');assert.equal(tracker.snapshot().sessions.length,0);
});

test('gateway monitor restart resets observation baseline instead of replaying history as new output',async t=>{
  const {dir,store,runtime}=fixture(t);
  const record=store.upsertSession({cwd:dir});await runtime.ensureSession(record.id,dir);
  const first=createSessionStatus(store,runtime);latestPty().emitData('old');
  const old=first.snapshot();first.dispose();
  const next=createSessionStatus(store,runtime);t.after(()=>next.dispose());
  const current=next.snapshot();assert.notEqual(current.monitorId,old.monitorId);
  assert.equal(current.sessions[0].outputSeq,null);assert.equal(current.sessions[0].state,'quiet');
});

test('HTTP and a single read-only WebSocket expose all sessions without attaching PTY viewers',async t=>{
  const {dir,store,runtime}=fixture(t);
  const record=store.upsertSession({cwd:dir});await runtime.ensureSession(record.id,dir);
  const server=createBackendServer({ auth: false,store,runtime,workspaceRoot:dir});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const initial=await (await fetch(base+'/api/session-status')).json();assert.equal(initial.sessions.length,1);
  const ws=new WebSocket(base.replace('http:','ws:')+'/api/session-status');
  const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(String(data))));
  await once(ws,'open');latestPty().emitData('new output');
  for(let i=0;i<100&&!messages.some(m=>m.sessions[0]?.state==='active');i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(messages.some(m=>m.sessions[0]?.state==='active'));
  assert.equal(messages[0].monitorId,initial.monitorId);
  ws.send('input is forbidden');const [code]=await once(ws,'close');assert.equal(code,1008);
  const rejected=new WebSocket(base.replace('http:','ws:')+'/api/session-status',{origin:'https://untrusted.example'});
  await new Promise<void>(resolve=>{rejected.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,403);res.resume();resolve()});rejected.on('error',()=>{})});
});


test('agent 自报状态与 PTY 活动是两条正交的轴，且 idle_prompt 不得覆盖已到达的 stop', async t => {
  const { dir, store, runtime } = fixture(t);
  let time = 10000;
  const record = store.upsertSession({ cwd: dir });
  const tracker = createSessionStatus(store, runtime, () => time);
  t.after(() => tracker.dispose());
  await runtime.ensureSession(record.id, dir);
  const pty = latestPty();
  const agentOf = () => { tracker.refresh(); return tracker.snapshot().sessions[0].agent; };
  const emit = (payload: Record<string, unknown>) =>
    pty.emitData(`\x1b]777;notify;warp://cli-agent;${JSON.stringify({ v: 1, agent: 'omp', ...payload })}\x07`);

  assert.equal(agentOf(), null, '没有 agent 在跑时不编造状态');

  emit({ event: 'session_start', session_id: 'a1' });
  assert.equal(agentOf()?.state, 'idle');
  assert.equal(agentOf()?.name, 'omp');

  emit({ event: 'prompt_submit', query: 'hi' });
  assert.equal(agentOf()?.state, 'working');

  // 关键区分：等你批准时 PTY 恰恰是安静的，两条轴必须能同时表达。
  emit({ event: 'permission_request' });
  assert.equal(agentOf()?.state, 'blocked');
  assert.equal(agentOf()?.waitingFor, 'permission');
  // 事件本身也是输出字节，所以刚发完 PTY 是 active；等它安静下来之后，
  // 「PTY 无输出」与「agent 在等你」这两个事实必须能同时成立——
  // 这正是单靠静默无法表达、而这条协议解决掉的那个区分。
  time += 10000;
  tracker.refresh();
  assert.equal(tracker.snapshot().sessions[0].state, 'quiet');
  assert.equal(agentOf()?.state, 'blocked');

  emit({ event: 'question_asked' });
  assert.equal(agentOf()?.waitingFor, 'question', '等回答与等批准要分得开');

  emit({ event: 'permission_replied' });
  assert.equal(agentOf()?.state, 'working');

  emit({ event: 'stop', response: 'done' });
  assert.equal(agentOf()?.state, 'done');

  // agent 收工后回到提示符也会发 idle_prompt。若据此改状态，
  // 「跑完了」这个信息就凭空消失了。
  emit({ event: 'idle_prompt' });
  assert.equal(agentOf()?.state, 'done', 'idle_prompt 必须是 no-op');

  // 协议以后会加事件，未知事件不得把状态打乱。
  emit({ event: 'brand_new_event' });
  assert.equal(agentOf()?.state, 'done');

  emit({ event: 'stop_failure' });
  assert.equal(agentOf()?.state, 'failed');

  // 换一条 shell 就换了一个 agent 进程，旧状态不该跟着新实例走。
  pty.emitExit();
  await runtime.ensureSession(record.id, dir);
  assert.equal(agentOf(), null, '新实例上不得残留旧 agent 状态');
});


test('迟到的解除阻塞事件不得把已完成的一轮翻回运行中', async t => {
  const { dir, store, runtime } = fixture(t);
  let time = 10000;
  const record = store.upsertSession({ cwd: dir });
  const tracker = createSessionStatus(store, runtime, () => time);
  t.after(() => tracker.dispose());
  await runtime.ensureSession(record.id, dir);
  const pty = latestPty();
  const agentOf = () => { tracker.refresh(); return tracker.snapshot().sessions[0].agent; };
  const emit = (payload: Record<string, unknown>) =>
    pty.emitData(`\x1b]777;notify;warp://cli-agent;${JSON.stringify({ v: 1, agent: 'omp', ...payload })}\x07`);

  emit({ event: 'session_start', session_id: 'a1' });
  emit({ event: 'prompt_submit' });
  emit({ event: 'stop' });
  assert.equal(agentOf()?.state, 'done');

  // tool_complete / permission_replied 只是「解除阻塞」的信号，不是「开始干活」的信号。
  // 这一轮已经收工，迟到的它们必须是 no-op，否则看起来像任务自己又跑起来了。
  emit({ event: 'tool_complete' });
  assert.equal(agentOf()?.state, 'done', '迟到的 tool_complete 必须是 no-op');
  emit({ event: 'permission_replied' });
  assert.equal(agentOf()?.state, 'done', '迟到的 permission_replied 必须是 no-op');

  emit({ event: 'stop_failure' });
  emit({ event: 'tool_complete' });
  assert.equal(agentOf()?.state, 'failed', '失败态同样不该被解除阻塞的信号顶掉');

  // 确实卡在 blocked 时，它们才是有效的放行信号。
  emit({ event: 'permission_request' });
  assert.equal(agentOf()?.state, 'blocked');
  emit({ event: 'tool_complete' });
  assert.equal(agentOf()?.state, 'working', '真的在 blocked 时才放行');
});

test('权限态的展示字段只在 blocked 期间存在，放行后必须清空', async t => {
  const { dir, store, runtime } = fixture(t);
  let time = 10000;
  const record = store.upsertSession({ cwd: dir });
  const tracker = createSessionStatus(store, runtime, () => time);
  t.after(() => tracker.dispose());
  await runtime.ensureSession(record.id, dir);
  const pty = latestPty();
  const agentOf = () => { tracker.refresh(); return tracker.snapshot().sessions[0].agent; };
  const emit = (payload: Record<string, unknown>) =>
    pty.emitData(`\x1b]777;notify;warp://cli-agent;${JSON.stringify({ v: 1, agent: 'omp', ...payload })}\x07`);

  emit({ event: 'session_start' });
  assert.equal(agentOf()?.summary, null, '不在 blocked 时这几项就该是空的');

  emit({ event: 'permission_request', summary: 'Wants to run Bash: rm -rf /tmp',
    tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp' } });
  assert.equal(agentOf()?.summary, 'Wants to run Bash: rm -rf /tmp');
  assert.equal(agentOf()?.toolName, 'Bash');
  assert.equal(agentOf()?.toolInputPreview, 'rm -rf /tmp');

  // 放行之后这件事就不再成立；留着会让早就批准完的摘要继续挂在会话行和通知上。
  emit({ event: 'permission_replied' });
  assert.equal(agentOf()?.state, 'working');
  assert.equal(agentOf()?.summary, null);
  assert.equal(agentOf()?.toolName, null);
  assert.equal(agentOf()?.toolInputPreview, null);

  emit({ event: 'question_asked', summary: '选哪个分支？' });
  assert.equal(agentOf()?.summary, '选哪个分支？', '等回答同样带得上具体那句话');
  emit({ event: 'stop' });
  assert.equal(agentOf()?.summary, null, '收工也算离开 blocked');
});
