import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';

export const entry=fileURLToPath(new URL('../src/stdio.mjs',import.meta.url));
export const pins={expectedConversationId:'conversation-A',expectedRunId:'run-A'};
export const input={...pins,recipientId:'conversation-B',requestId:'business-key',text:'hello\n世界🙂'};
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read,timeout=2000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=read();if(value)return value;await delay(10);}throw new Error('bounded fixture wait failed');}
export async function fakeOwner(t,handler){
  const dir=await mkdtemp(join(tmpdir(),'agent-mcp-')),socketPath=join(dir,'o.sock'),sockets=new Set(),requests=[];
  const env={ROOST_AGENT_SOCKET:socketPath,ROOST_AGENT_TERMINAL:'terminal-A',ROOST_AGENT_INSTANCE:'instance-A',ROOST_AGENT_TOKEN:'a'.repeat(64)};
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');let buffer='';socket.write(JSON.stringify({type:'hello'})+'\n');socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);requests.push(request);const reply=result=>socket.write(JSON.stringify({type:'reply',requestId:request.requestId,result})+'\n');handler?.({socket,request,reply});}});});
  await new Promise(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return{dir,env,requests,sockets};
}
export async function stdio(t,env){
  const child=spawn(process.execPath,[entry],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',buffer='',stdin='';const frames=[],parseErrors=[];
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{frames.push(JSON.parse(line));}catch{parseErrors.push(line);}}});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',()=>{});
  t.after(async()=>{child.stdin.end();for(let i=0;i<50&&child.exitCode===null;i++)await delay(10);if(child.exitCode===null){child.kill('SIGTERM');await delay(50);}if(child.exitCode===null)child.kill('SIGKILL');assert.equal(parseErrors.length,0,'stdout contained non-protocol output');assert.equal(buffer.trim(),'','stdout ended with an unterminated protocol frame');assert.ok(!stdout.includes(env.ROOST_AGENT_TOKEN)&&!stderr.includes(env.ROOST_AGENT_TOKEN),'stdio leaked scoped token');assert.ok(!stdin.includes(env.ROOST_AGENT_TOKEN),'token entered MCP stdin');});
  const write=raw=>{stdin+=raw;child.stdin.write(raw);};
  const send=message=>write(JSON.stringify(message)+'\n');
  async function request(id,method,params={}){send({jsonrpc:'2.0',id,method,params});return until(()=>frames.find(frame=>frame.id===id),4000);}
  async function initialize(){const result=await request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'isolated-qa',version:'1'}});assert.equal(result.result.protocolVersion,'2025-11-25');send({jsonrpc:'2.0',method:'notifications/initialized'});return result;}
  return{child,frames,write,send,request,initialize,get stdout(){return stdout},get stderr(){return stderr}};
}
