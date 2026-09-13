import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node-pty';
import { createClaudeLaunch } from '../src/claude-launch.ts';
import { createServer } from 'node:net';

const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
async function until(check:()=>boolean){for(let i=0;i<160;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}assert.fail('PTY condition timed out');}

test('ordinary zsh claude loads scoped plugin, preserves arguments and original startup files', {timeout:15000}, async t=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-launch-test-')),bin=join(dir,'bin');await mkdir(bin);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const original=`export PATH=${quote(bin)}:/usr/bin:/bin\nexport ROOST_TEST_RC=loaded\n`;
 await writeFile(join(dir,'.zshrc'),original);
 await writeFile(join(bin,'claude'),`#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);console.log('ARGS='+JSON.stringify(args));console.log('RC='+process.env.ROOST_TEST_RC);
const index=args.indexOf('--plugin-dir');
if(index>=0){const plugin=args[index+1],config=JSON.parse(readFileSync(plugin+'/hooks/hooks.json','utf8'));
 for(const hook_event_name of ['SessionStart','UserPromptSubmit','Stop']){
  const command=config.hooks[hook_event_name][0].hooks[0].command;
  const result=spawnSync(command,{shell:true,env:{...process.env,CLAUDE_PLUGIN_ROOT:plugin},input:JSON.stringify({hook_event_name,session_id:'native-test',transcript_path:'/tmp/explicit-test.jsonl'}),encoding:'utf8'});
  if(result.stdout||result.stderr||result.status!==0)throw Error('hook polluted control channel');
 }
}
console.log('FAKE_CLAUDE_FINISHED');
`,{mode:0o700});
 const events:any[]=[];
 const socketPath=join(dir,'hook.sock');
 const receiver=createServer(socket=>{let buf='';socket.on('data',chunk=>{buf+=chunk;const i=buf.indexOf('\n');if(i<0)return;const m=JSON.parse(buf.slice(0,i));events.push(m.args[0]);socket.end(JSON.stringify({type:'reply',requestId:m.requestId,result:true})+'\n');});});
 await new Promise<void>(r=>receiver.listen(socketPath,r));t.after(()=>new Promise<void>(r=>receiver.close(()=>r())));
 const launch=await createClaudeLaunch('/bin/zsh',{...process.env,HOME:dir,ZDOTDIR:dir,ROOST_CLAUDE_SOCKET:socketPath,ROOST_CLAUDE_TOKEN:'test',ROOST_CLAUDE_INSTANCE:'instance',ROOST_CLAUDE_TERMINAL:'terminal'});
 t.after(()=>launch.dispose());
 const terminal=spawn('/bin/zsh',['-l'],{cwd:dir,env:launch.env as Record<string,string>,name:'xterm-256color',cols:80,rows:24});
 t.after(()=>terminal.kill());
 let output='';terminal.onData(s=>{output+=s;});
 terminal.write("claude 'argument with spaces' --model test\r");
 await until(()=>events.length===3 && output.includes('FAKE_CLAUDE_FINISHED'));
 assert.deepEqual(events.map(e=>e.event),['SessionStart','UserPromptSubmit','Stop']);
 assert.ok(events.every(e=>e.terminalId==='terminal' && e.instanceId==='instance' && e.sessionId==='native-test' && e.transcriptPath==='/tmp/explicit-test.jsonl'));
 assert.ok(output.includes('"argument with spaces","--model","test"'));
 assert.ok(output.includes('RC=loaded'));
 assert.equal(await readFile(join(dir,'.zshrc'),'utf8'),original);
 terminal.write('claude --version\r');await until(()=>output.includes('ARGS=["--version"]'));
 assert.equal(events.length,3,'version does not load observer');
 await launch.dispose();await assert.rejects(stat(launch.env.ZDOTDIR!),{code:'ENOENT'});
});

test('non-zsh launch is unchanged',async()=>{
 const env={PATH:'/bin'};const launch=await createClaudeLaunch('/bin/bash',env);
 assert.equal(launch.env,env);await launch.dispose();
});

test('daemon authenticates hook instance and journals it without a gateway', {timeout:15000}, async t=>{
 const {startTerminalOwner}=await import('../src/owner.ts');
 const {connectTerminalDaemon}=await import('../src/client.ts');
 const {createConnection}=await import('node:net');
 const dir=await mkdtemp(join(tmpdir(),'claude-hook-owner-')),socketPath=join(dir,'d.sock');
 const owner=await startTerminalOwner({dataDir:dir,socketPath,shell:'/bin/sh',defaultCwd:dir});
 const client=await connectTerminalDaemon(socketPath);
 t.after(async()=>{client.dispose();await owner.stop();await rm(dir,{recursive:true,force:true});});
 const initial=await client.ensureSession('session',dir),path=join(dir,'credentials.json');
 const script=`require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({terminalId:process.env.ROOST_CLAUDE_TERMINAL,instanceId:process.env.ROOST_CLAUDE_INSTANCE,token:process.env.ROOST_CLAUDE_TOKEN}),{mode:384})`;
 client.writeSession('session',`${quote(process.execPath)} -e ${quote(script)}\n`);
 let input:any;
 for(let i=0;i<100;i++){try{input=JSON.parse(await readFile(path,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.ok(input);input={...input,event:'SessionStart',sessionId:'native',transcriptPath:'/tmp/transcript.jsonl'};
 const call=(value:any)=>new Promise<any>((resolve,reject)=>{
  const socket=createConnection(socketPath);let buf='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('hook timeout'));},2000);
  socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));
  socket.on('connect',()=>socket.write(JSON.stringify({requestId:1,method:'claudeHook',args:[value]})+'\n'));
  socket.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(m.type==='reply'){socket.destroy();resolve(m);}}});
 });
 assert.equal((await call({...input,token:'0'.repeat(64)})).error,'invalid hook instance');
 assert.equal((await call({...input,event:'unknown'})).error,'invalid hook event');
 assert.equal((await call(input)).result,true);
 const page=await client.readAgentEvents!('session',initial.instanceId,0);
 assert.equal(page.events.length,1);assert.equal(page.events[0].agent.sessionId,'native');assert.equal(page.events[0].agent.agent,'claude');
 await client.killSession('session');await client.ensureSession('session',dir);
 assert.equal((await call(input)).error,'invalid hook instance');
});

for(const controlled of [true,false])test(`Claude suggestion override is child scoped when controlled input is ${controlled}`,{timeout:20000},async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const execute=promisify(execFile);
 const dir=await mkdtemp(join(tmpdir(),'claude-suggestion-launch-')),bin=join(dir,'bin');await mkdir(bin);t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'.zshrc'),`export PATH=${quote(bin)}:/usr/bin:/bin\n`);
 await writeFile(join(bin,'claude'),`#!${process.execPath}
console.log(JSON.stringify({kind:'test-cli',args:process.argv.slice(2),suggestion:process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION??null,observing:process.env.ROOST_CLAUDE_OBSERVING??null}));
if(process.argv.includes('--version'))console.log('2.1.266');
`,{mode:0o700});
 const cases=[
  {args:['argument with spaces','--model','test'],observe:true},
  {args:['--help'],observe:false},{args:['--version'],observe:false},
  {args:['-p','argument with spaces'],observe:true,print:true},
  {args:['--print','argument with spaces'],observe:true,print:true},
  {args:['--print=json'],observe:true,print:true},
  {args:['nested argument'],observe:false,nested:true},
 ];
 for(const suggestion of ['true',undefined]){
  const env={...process.env,HOME:dir,ZDOTDIR:dir,ROOST_CLAUDE_GUI_SEND:controlled?'1':'0',CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION:suggestion};delete env.ROOST_CLAUDE_OBSERVING;
  const launch=await createClaudeLaunch('/bin/zsh',env);t.after(()=>launch.dispose());
  for(const example of cases){
   const prefix=example.nested?'ROOST_CLAUDE_OBSERVING=1 ':'';
   const command=prefix+'claude '+example.args.map(quote).join(' ')+`; print -r -- "PARENT=\${CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION-__unset__}"`;
   const result=await execute('/bin/zsh',['-i','-c',command],{cwd:dir,env:launch.env,timeout:5000});
   const observed=result.stdout.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).filter(x=>x.kind==='test-cli');assert.equal(observed.length,1);
   const row=observed[0],expected=controlled&&example.observe&&!example.print?'false':suggestion??null;
   assert.equal(row.suggestion,expected,JSON.stringify({controlled,suggestion,args:example.args}));
   assert.equal(row.observing,example.observe||example.nested?'1':null);
   if(example.observe){assert.equal(row.args[0],'--plugin-dir');assert.deepEqual(row.args.slice(2),example.args);}else assert.deepEqual(row.args,example.args);
   assert.ok(result.stdout.includes('PARENT='+(suggestion??'__unset__')),'override must not mutate calling shell');
   assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION,suggestion);assert.equal(launch.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION,suggestion);
  }
 }
});
