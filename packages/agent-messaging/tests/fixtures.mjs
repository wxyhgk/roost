import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
