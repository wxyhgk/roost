import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '@roost/workspace-store';
import { openTerminalDaemon } from '../src/index.ts';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('running owner reads CLI configuration changes without restarting owner or PTY', {timeout:20000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roost-cli-owner-'));
  const store=createWorkspaceStore({dataDir:dir});
  let client:Awaited<ReturnType<typeof openTerminalDaemon>>|undefined;
  t.after(async()=>{
    const pid=client?.ownerPid;client?.dispose();
    if(pid){try{process.kill(pid,'SIGTERM')}catch{} }
    for(let i=0;i<100&&pid;i++){try{process.kill(pid,0)}catch{break}await delay(20)}
    store.close();await rm(dir,{recursive:true,force:true});
  });
  client=await openTerminalDaemon({dataDir:dir,shell:'/bin/sh'});
  const owner=client.ownerPid,session=await client.ensureSession('test',dir);
  client.writeSession('test','sleep 30\n');
  store.cliConfigs.create({id:'custom-sleep',name:'Test',command:'sleep 30',rules:[{kind:'executable',value:'sleep'}],builtin:false,enabled:true,priority:0,iconRef:null});
  async function waitFor(value:string|null){for(let i=0;i<70;i++){if(client?.getSession('test')?.cli===value)return;await delay(100)}assert.equal(client?.getSession('test')?.cli,value)}
  await waitFor('custom-sleep');
  store.cliConfigs.update('custom-sleep',{enabled:false});
  await waitFor(null);
  assert.equal(client.ownerPid,owner);assert.equal(client.getSession('test')?.pid,session.pid);assert.equal(client.getSession('test')?.instanceId,session.instanceId);
});
