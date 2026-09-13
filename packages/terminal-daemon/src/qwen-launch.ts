import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSync, closeSync, fstatSync, writeSync, constants } from 'node:fs';
/** Single bounded native submission, never a PTY key sequence or automatic retry. */
export function writeQwenCommand(inputPath: string, text: string) {
  if (!text.trim() || text !== text.trim() || Buffer.byteLength(text) > 16384 || /^[\s]*\//.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('unsupported_input');
  const fd = openSync(inputPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('input_file_unavailable');
    const bytes = Buffer.from(JSON.stringify({type: 'submit', text}) + '\n');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('partial_write');
  } finally { closeSync(fd); }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Install alongside Claude in the daemon-local PATH; no user configuration is written. */
export async function installQwenLaunch(bin: string, dir: string) {
  const runtimeRoot = join(dir, 'qwen-runtime');
  await mkdir(runtimeRoot, {recursive: true, mode: 0o700});
  await writeFile(join(dir, 'qwen-launch.mjs'), QWEN_LAUNCH_SCRIPT.replace('__RUNTIME_ROOT__', JSON.stringify(runtimeRoot)).replace('__BIN__', JSON.stringify(bin)));
  await writeFile(join(bin, 'qwen'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(dir, 'qwen-launch.mjs'))} "$@"\n`, {mode: 0o700});
  return runtimeRoot;
}
export const QWEN_LAUNCH_SCRIPT = `import {spawn,spawnSync} from 'node:child_process';
import {accessSync,constants,realpathSync,mkdtempSync,writeFileSync,rmSync,readdirSync,statSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {delimiter,join} from 'node:path';
import {createConnection} from 'node:net';
import {StringDecoder} from 'node:string_decoder';
import {homedir} from 'node:os';
const root=__RUNTIME_ROOT__,bin=__BIN__,e=process.env;
const paths=(e.PATH??'').split(delimiter).filter(p=>{try{return realpathSync(p)!==realpathSync(bin)}catch{return p!==bin}});
const executable=paths.map(p=>join(p,'qwen')).find(p=>{try{accessSync(p,constants.X_OK);return true}catch{return false}});
if(!executable){console.error('qwen: command not found');process.exit(127)}
const args=process.argv.slice(2);
let version='';try{version=(spawnSync(executable,['--version'],{encoding:'utf8',timeout:2000}).stdout??'').trim()}catch{}
const management=['auth','channel','extensions','hooks','mcp','review','serve','sessions','update'].includes(args[0]);
const observe=!management&&version==='0.23.1'&&e.ROOST_QWEN_OBSERVING!=='1'&&e.ROOST_QWEN_SOCKET&&e.ROOST_QWEN_TOKEN&&!args.some(a=>/^(--help|-h|--version|-v|--acp|--json-fd|--json-file|--input-file|--output-format|-o|--prompt|-p)(=|$)/.test(a));
const dir=observe?mkdtempSync(join(root,'run-')):null,inputPath=dir?join(dir,'input.jsonl'):null,outputPath=dir?join(dir,'output.jsonl'):null;
if(inputPath)writeFileSync(inputPath,'',{mode:0o600});
let sessionId='',pending='',disabled=false;const decoder=new StringDecoder('utf8');
// Serialize metadata deliveries so SessionStart cannot be overtaken by a user event.
let deliveries=Promise.resolve();
function transcript(id){try{const projects=e.ROOST_QWEN_PROJECTS_ROOT??join(e.HOME??homedir(),'.qwen','projects');const entries=readdirSync(projects,{withFileTypes:true});if(entries.length>10000)return;const paths=entries.filter(p=>p.isDirectory()).map(p=>join(projects,p.name,'chats',id+'.jsonl')).filter(p=>{try{return statSync(p).isFile()}catch{return false}});return paths.length===1?paths[0]:undefined}catch{}}

function emit(event,prompt){if(!sessionId||disabled)return;const capturedId=sessionId,transcriptPath=transcript(sessionId);deliveries=deliveries.then(()=>new Promise(resolve=>{
 const s=createConnection(e.ROOST_QWEN_SOCKET),timer=setTimeout(()=>s.destroy(),1200);s.on('error',()=>{});s.on('close',()=>{clearTimeout(timer);resolve()});
 s.on('connect',()=>s.write(JSON.stringify({requestId:'qwen-event',method:'qwenEvent',args:[{terminalId:e.ROOST_QWEN_TERMINAL,instanceId:e.ROOST_QWEN_INSTANCE,token:e.ROOST_QWEN_TOKEN,event,sessionId:capturedId,version,protocolVersion:2,inputPath,transcriptPath,prompt}]})+'\\n'));
 let replies='';s.on('data',c=>{replies+=c;if(replies.length>1048576){s.destroy();return}let n;while((n=replies.indexOf('\\n'))>=0){const l=replies.slice(0,n);replies=replies.slice(n+1);try{const r=JSON.parse(l);if(r.type==='reply'&&r.requestId==='qwen-event')s.destroy()}catch{s.destroy()}}});
}));}
function line(raw){let b;try{b=JSON.parse(raw)}catch{return}
 if(b.parent_tool_use_id)return;
 const id=b.session_id;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,512}$/.test(id))return;
 if(b.type==='system'&&b.subtype==='session_start'){if(b.data?.protocol_version!==2){disabled=true;return}sessionId=id;emit('SessionStart');return}
 // A changed identity requires its own start event, never bind by recent-file heuristics.
 if(id!==sessionId)return;
 if(b.type==='user'&&Array.isArray(b.message?.content)&&b.message.content.every(p=>p.type==='text'&&typeof p.text==='string')){const text=b.message.content.map(p=>p.text).join('\\n');emit('UserPromptSubmit',Buffer.byteLength(text)<=16384?text:undefined)}
 else if(b.type==='result')emit('Stop');
 else if(b.type==='control_request'&&b.request?.subtype==='can_use_tool')emit('PermissionRequest');
}
const child=spawn(executable,observe?['--json-file',outputPath,'--input-file',inputPath,...args]:args,{stdio:'inherit',env:{...e,PATH:paths.join(delimiter),...(observe?{ROOST_QWEN_OBSERVING:'1'}:{})}});
let offset=0;
function poll(){if(!observe||disabled)return;let fd;try{fd=openSync(outputPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const st=fstatSync(fd);if(!st.isFile()||st.size<offset){disabled=true;return}const buf=Buffer.alloc(Math.min(262144,st.size-offset));const count=readSync(fd,buf,0,buf.length,offset);offset+=count;pending+=decoder.write(buf.subarray(0,count));let i;while((i=pending.indexOf('\\n'))>=0){const row=pending.slice(0,i);pending=pending.slice(i+1);if(row.length<=1048576)line(row)}if(pending.length>1048576){pending='';disabled=true}}catch{}finally{if(fd!==undefined)closeSync(fd)}}
const poller=observe?setInterval(poll,100):null;
for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));process.on('SIGINT',()=>{});
child.on('error',()=>{console.error('qwen: launch failed');process.exitCode=126});
child.on('exit',async(code,signal)=>{if(poller)clearInterval(poller);poll();emit('SessionEnd');await deliveries;if(dir)rmSync(dir,{recursive:true,force:true});process.exitCode=code??(signal==='SIGINT'?130:1)});
`;
