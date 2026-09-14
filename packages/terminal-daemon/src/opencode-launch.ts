import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPENCODE_OBSERVATION_PROTOCOL_VERSION } from './opencode-protocol.ts';
import { CLI_LAUNCH_TOOLS } from './cli-launch-tools.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Process-local OpenCode TUI plugin. Does not edit global or project configuration. */
export async function installOpenCodeLaunch(bin: string, runtimeDir: string) {
  const plugin = join(runtimeDir, 'opencode-observer.mjs');
  const config = join(runtimeDir, 'opencode-tui.json');
  const launch = join(runtimeDir, 'opencode-launch.mjs');
  await writeFile(plugin, OPENCODE_TUI_OBSERVER_SCRIPT);
  await writeFile(config, JSON.stringify({ plugin: [pathToFileURL(plugin).href] }));
  await writeFile(launch, openCodeLaunchScript(bin, config));
  await writeFile(join(bin, 'opencode'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(launch)} "$@"\n`, { mode: 0o700 });
}

export function openCodeLaunchScript(bin: string, config: string) {
  return `import {spawn} from 'node:child_process';
import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {delimiter,join,resolve} from 'node:path';
${CLI_LAUNCH_TOOLS}
const bin=${JSON.stringify(bin)},config=${JSON.stringify(config)};
const paths=(process.env.PATH??'').split(delimiter).filter(p=>{try{return realpathSync(p)!==realpathSync(bin)}catch{return p!==bin}});
const executable=requireCli(paths,'opencode');
const args=cliArgs(), e=process.env;
const commands=new Set(['completion','acp','mcp','attach','run','debug','providers','auth','agent','upgrade','uninstall','serve','web','models','stats','export','import','github','pr','session','plugin','plug','db']);
let observe=!e.ROOST_OPENCODE_OBSERVING&&!e.OPENCODE_TUI_CONFIG&&e.OPENCODE_PURE!=='1'&&e.OPENCODE_PURE!=='true'&&!!e.ROOST_OPENCODE_SOCKET&&
 !args.some(a=>['--help','-h','--version','-v','--pure','--mini','--mdns'].includes(a))&&!commands.has(args[0]);
const value=(flag)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:args.find(a=>a.startsWith(flag+'='))?.slice(flag.length+1)};
let port=value('--port'), hostname=value('--hostname');
if(hostname&&hostname!=='127.0.0.1')observe=false;
if(port!==undefined&&!/^\\d+$/.test(port))observe=false;
if(port!==undefined&&(Number(port)>65535||Number(port)<0))observe=false;
const extra=[];
if(observe){
 if(!port||Number(port)===0){
  try{port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(error=>error?reject(error):resolve(String(p)))})})}catch{observe=false}
  if(observe){for(let i=args.length-1;i>=0;i--){if(args[i].startsWith('--port='))args.splice(i,1);else if(args[i]==='--port')args.splice(i,2)}extra.push('--port',port)}
 }
 if(!hostname)extra.push('--hostname','127.0.0.1');
}
const child=spawnCli(executable,[...extra,...args],{stdio:'inherit',env:{...e,PATH:paths.join(delimiter),...(observe?{OPENCODE_TUI_CONFIG:config,ROOST_OPENCODE_OBSERVING:'1',ROOST_OPENCODE_ENDPOINT:'http://127.0.0.1:'+port}:{})}});
for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
process.on('SIGINT',()=>{});
child.on('error',()=>{console.error('opencode: launch failed');process.exitCode=126});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1)});
`;
}

/** The route belongs to this TUI; service-wide session events alone never establish identity. */
export const OPENCODE_TUI_OBSERVER_SCRIPT = `import {createConnection} from 'node:net';
import {isAbsolute} from 'node:path';
export const id='roost-terminal-observer';
export async function tui(api){
 const e=process.env;
 // Detect the APIs we consume, not a product version. Missing capabilities disable
 // observation without affecting the CLI or inferring completion from silence.
 if(!api?.route||typeof api.route!=='object'||!('current' in api.route)||
  !['get','status','permission','question'].every(key=>typeof api.state?.session?.[key]==='function')||
  typeof api.lifecycle?.onDispose!=='function'||!e.ROOST_OPENCODE_SOCKET||!e.ROOST_OPENCODE_TOKEN||!e.ROOST_OPENCODE_TERMINAL||!e.ROOST_OPENCODE_INSTANCE)return;
 let base;try{base=new URL(e.ROOST_OPENCODE_ENDPOINT);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password)return}catch{return}
 let selected=null,lastState='',running=false,disposed=false,lastReport=0;
 async function send(event,selection){
  return await new Promise(resolve=>{
   let done=false,pending='';const socket=createConnection(e.ROOST_OPENCODE_SOCKET);
   const finish=ok=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok)};
   const timer=setTimeout(()=>finish(false),1000);
   socket.on('error',()=>finish(false));socket.on('close',()=>finish(false));
   socket.on('connect',()=>socket.write(JSON.stringify({requestId:'opencode-hook',method:'opencodeEvent',args:[{terminalId:e.ROOST_OPENCODE_TERMINAL,instanceId:e.ROOST_OPENCODE_INSTANCE,token:e.ROOST_OPENCODE_TOKEN,event,sessionId:selection.id,transcriptPath:selection.endpoint,protocolVersion:${OPENCODE_OBSERVATION_PROTOCOL_VERSION}}]})+'\\n'));
   socket.on('data',chunk=>{pending+=chunk;if(pending.length>65536)return finish(false);let i;while((i=pending.indexOf('\\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const m=JSON.parse(line);if(m.type==='reply'&&m.requestId==='opencode-hook')return finish(!m.error)}catch{return finish(false)}}});
  });
 }
 function current(){
  const route=api.route.current,id=route?.name==='session'?route.params?.sessionID:null;
  if(typeof id!=='string'||!/^ses[a-zA-Z0-9_-]{1,253}$/.test(id))return null;
  const session=api.state.session.get(id);
  if(!session||session.id!==id||typeof session.directory!=='string'||!isAbsolute(session.directory)||session.directory.length>4096)return null;
  const endpoint=new URL(base);endpoint.searchParams.set('directory',session.directory);
  return{id,endpoint:endpoint.href};
 }
 async function poll(){
  if(running||disposed)return;running=true;
  try{
   const next=current();
   if(selected&&(selected.id!==next?.id||selected.endpoint!==next?.endpoint)){
    if(!await send('SessionEnd',selected))return;selected=null;lastState='';
   }
   if(!next)return;
   if(!selected){if(!await send('SessionStart',next))return;selected=next;lastReport=Date.now();lastState=''}
   const status=api.state.session.status(next.id)?.type;
   const permission=api.state.session.permission?.(next.id)?.length||api.state.session.question?.(next.id)?.length;
   const event=permission?'PermissionRequest':status==='busy'||status==='retry'?'UserPromptSubmit':status==='idle'?'Stop':'';
   if(event&&(event!==lastState||Date.now()-lastReport>10000)){
    if(await send(event,next)){lastState=event;lastReport=Date.now()}
   }
  }catch{}finally{running=false}
 }
 const interval=setInterval(poll,250);interval.unref?.();void poll();
 api.lifecycle.onDispose(async()=>{disposed=true;clearInterval(interval);while(running)await new Promise(resolve=>setTimeout(resolve,10));if(selected)await send('SessionEnd',selected)});
}
export default {id,tui};
`;
