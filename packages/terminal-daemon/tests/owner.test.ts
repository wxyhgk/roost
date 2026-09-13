import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTerminalDaemon, daemonSocketPath } from '../src/index.ts';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('concurrent gateways share one detached owner; disconnect preserves PID, output and cursor', {timeout:20000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roost-owner-test-'));
  const clients:Awaited<ReturnType<typeof openTerminalDaemon>>[]=[];
  let ownerPid:number|undefined;
  t.after(async()=>{
    for(const client of clients)client.dispose();
    if(ownerPid){try{process.kill(ownerPid,'SIGTERM')}catch{}}
    for(let i=0;i<100;i++){try{if(ownerPid)process.kill(ownerPid,0);else break}catch{break}await delay(20)}
    await rm(dir,{recursive:true,force:true});
    await rm(daemonSocketPath(await realpath(tmpdir())+'/'+dir.split('/').at(-1))+'.lock',{force:true});
  });
  const [a,b]=await Promise.all([openTerminalDaemon({dataDir:dir,shell:'/bin/sh'}),openTerminalDaemon({dataDir:dir,shell:'/bin/sh'})]);
  clients.push(a,b);ownerPid=a.ownerPid;
  assert.equal(a.ownerPid,b.ownerPid);
  // detached:true alone does not escape tree-kill/concurrently: the owner must
  // no longer be a descendant of the gateway which originally launched it.
  let gatewayAncestor = true;
  for (let attempt = 0; attempt < 50 && gatewayAncestor; attempt++) {
    let pid = ownerPid;
    gatewayAncestor = false;
    while (pid > 1) {
      if (pid === process.pid) { gatewayAncestor = true; break; }
      try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
      catch { break; }
    }
    if (gatewayAncestor) await delay(20);
  }
  assert.equal(gatewayAncestor, false, 'terminal owner must escape recursive gateway process cleanup');
  const session=await a.ensureSession('s',dir);
  assert.equal((await b.ensureSession('s',dir)).pid,session.pid);
  const cursor=await a.resume('s');assert.ok(cursor);
  a.writeSession('s',"sleep 0.2; printf '\\137\\137OFFLINE_MARK\\137\\137\\n'\n");
  a.dispose();b.dispose();await delay(400);
  const c=await openTerminalDaemon({dataDir:dir});clients.push(c);
  assert.equal(c.ownerPid,ownerPid);assert.equal(c.getSession('s')?.pid,session.pid);
  assert.equal(c.getSession('s')?.instanceId,session.instanceId);
  let replay=await c.resume('s',{instanceId:session.instanceId,seq:cursor.seq});
  // Shell startup and sleep completion vary under parallel package load. Keep
  // the original cursor fixed and wait for actual persisted output, not time.
  for(let attempt=0;attempt<100&&!/__OFFLINE_MARK__/.test(replay?.data??'');attempt++) {
    await delay(50);replay=await c.resume('s',{instanceId:session.instanceId,seq:cursor.seq});
  }
  assert.equal(replay?.type,'catchup');assert.match(replay?.data??'',/__OFFLINE_MARK__/);
  assert.equal(await c.killSession('s'),true);assert.equal(c.getSession('s'),undefined);
});
