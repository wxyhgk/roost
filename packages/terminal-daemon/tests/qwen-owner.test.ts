import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {startTerminalOwner} from '../src/owner.ts';
import {connectTerminalDaemon} from '../src/client.ts';
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";

test('Qwen metadata requires current terminal credentials and a scoped launch input file; journals while sending stays off', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'qwen-owner-')),socketPath=join(dir,'daemon.sock');
 await writeFile(join(dir,'.zshrc'),'export PATH=/usr/bin:/bin\n');
 const oldHome=process.env.HOME,oldZdot=process.env.ZDOTDIR;
 process.env.HOME=dir;process.env.ZDOTDIR=dir;
 let owner:Awaited<ReturnType<typeof startTerminalOwner>>;
 try{owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/zsh',defaultCwd:dir});}
 finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldZdot===undefined)delete process.env.ZDOTDIR;else process.env.ZDOTDIR=oldZdot;}
 const client=await connectTerminalDaemon(socketPath);
 t.after(async()=>{client.dispose();await owner.stop();await rm(dir,{recursive:true,force:true});});
 const session=await client.ensureSession('s',dir),credentials=join(dir,'credentials.json');
 const script=`const fs=require('node:fs'),p=require('node:path');const bin=process.env.PATH.split(':').find(p=>p.includes('roost-cli-launch-'));const run=p.join(bin,'..','qwen-runtime','run-TEST');fs.mkdirSync(run);const inputPath=p.join(run,'input.jsonl');fs.writeFileSync(inputPath,'');fs.writeFileSync(${JSON.stringify(credentials)},JSON.stringify({terminalId:process.env.ROOST_QWEN_TERMINAL,instanceId:process.env.ROOST_QWEN_INSTANCE,token:process.env.ROOST_QWEN_TOKEN,inputPath}),{mode:384});`;
 client.writeSession('s',`${quote(process.execPath)} -e ${quote(script)}\r`);
 let credentialsValue:any;
 for(let i=0;i<120;i++){try{credentialsValue=JSON.parse(await readFile(credentials,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.ok(credentialsValue,'isolated zsh should expose only its scoped wrapper');
 const input={...credentialsValue,event:'SessionStart',sessionId:'native-qwen',version:'0.23.1',protocolVersion:2};
 const call=(value:any)=>new Promise<any>((resolve,reject)=>{
  const socket=createConnection(socketPath);let buf='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('metadata timeout'));},2000);
  socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));socket.on('connect',()=>socket.write(JSON.stringify({requestId:1,method:'qwenEvent',args:[value]})+'\n'));
  socket.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\n'))>=0){const message=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(message.type==='reply'){socket.destroy();resolve(message);}}});
 });
 assert.equal((await call({...input,token:'0'.repeat(64)})).error,'invalid hook instance');
 assert.equal((await call({...input,inputPath:credentials})).error,'invalid Qwen input path');
 assert.equal((await call({...input,protocolVersion:3})).error,'invalid Qwen event');
 assert.equal((await call(input)).result,true);
 assert.equal((await call({...input,event:'Stop',transcriptPath:join(dir,'native-qwen.jsonl')})).result,true);
 const page=await client.readAgentEvents!('s',session.instanceId,0);
 assert.deepEqual(page.events.map(e=>[e.agent.agent,e.agent.event,e.agent.sessionId]),[['qwen','session_start','native-qwen'],['qwen','stop','native-qwen']]);
 assert.equal(page.events[1].agent.transcriptPath,join(dir,'native-qwen.jsonl'));
 assert.equal((await client.commandControl!('s')).supported,false);
 await client.killSession('s');await client.ensureSession('s',dir);
 assert.equal((await call(input)).error,'invalid hook instance');
});
