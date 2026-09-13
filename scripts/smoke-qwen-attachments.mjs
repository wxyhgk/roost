import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const repo=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require=createRequire(repo+'/backend/package.json');
const sharp=require('sharp'); const {WebSocket}=require('ws');
const {planImageInsertion}=await import(repo+'/packages/cli-adapters/src/index.ts');
const {createWorkspaceStore}=await import(repo+'/packages/workspace-store/src/index.ts');
const {createTerminalRuntime}=await import(repo+'/packages/terminal-runtime/src/index.ts');
const {createBackendServer}=await import(repo+'/backend/src/server.ts');
const {createAttachmentStore}=await import(repo+'/backend/src/attachments.ts');
const dir=await fs.mkdtemp(join(tmpdir(),'roost-qwen-image-'));
const qwenHome=join(dir,'qwen-home'); await fs.mkdir(qwenHome);
let gotImage=false, modelCalls=0, output='';
const mock=createServer(async(req,res)=>{
 let raw=''; for await(const c of req)raw+=c;
 let body;try{body=JSON.parse(raw)}catch{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
 modelCalls++;
 const parts=(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]);
 for (const part of parts) {
   const url=part.type==='image_url' ? part.image_url?.url : undefined;
   if (typeof url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(url)) continue;
   const decoded=await sharp(Buffer.from(url.split(',')[1], 'base64')).raw().toBuffer({resolveWithObject:true});
   assert.equal(decoded.info.width,16); assert.equal(decoded.info.height,16);
   assert.ok(decoded.data[0]>240 && decoded.data[1]<15 && decoded.data[2]<15);
   gotImage=true;
 }
 const message='Attachment transport verified.';
 if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'smoke',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:message},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'smoke',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'smoke',choices:[{message:{role:'assistant',content:message},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
});
mock.listen(0,'127.0.0.1');await once(mock,'listening'); const api=`http://127.0.0.1:${mock.address().port}/v1`;
await fs.writeFile(join(qwenHome,'settings.json'),JSON.stringify({security:{folderTrust:{enabled:false},auth:{selectedType:'openai'}},modelProviders:{openai:[{id:'roost-vision-test',name:'Test',baseUrl:api,envKey:'OPENAI_API_KEY',capabilities:{vision:true},generationConfig:{modalities:{image:true}}}]},model:{name:'roost-vision-test'},general:{enableAutoUpdate:false},telemetry:{enabled:false}}));
const store=createWorkspaceStore({dataDir:join(dir,'data')});
const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{...process.env,QWEN_HOME:qwenHome,QWEN_RUNTIME_DIR:join(dir,'qwen-runtime'),OPENAI_API_KEY:'local-test',OPENAI_BASE_URL:api},historyStore:store});
const server=createBackendServer({store,runtime,workspaceRoot:dir,attachments:createAttachmentStore({directory:join(dir,'attachments')})});
let ws;
try{
 store.upsertSession({id:'image-smoke',cwd:dir});const live=runtime.ensureSession('image-smoke',dir);
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
 const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'screenshot.png');form.append('instanceId',live.instanceId);
 const upload=await fetch(base+'/api/sessions/image-smoke/attachments',{method:'POST',body:form});assert.equal(upload.status,201);const attachment=await upload.json();
 ws=new WebSocket(base.replace('http','ws')+'/api/pty?id=image-smoke');
 ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='output'||m.type==='replay')output+=m.data??'';});
 await once(ws,'open');ws.send(JSON.stringify({type:'ready',cols:120,rows:36}));
 const send=data=>ws.send(JSON.stringify({type:'input',data}));
 send(`exec qwen --auth-type openai --model diy-vision-test --openai-base-url ${api} --openai-api-key local-test --safe-mode --no-telemetry\r`);
 await new Promise(r=>setTimeout(r,6500));
 const insertion=planImageInsertion({cli:'qwen',path:attachment.path,version:'0.21.14'});
 assert.equal(insertion.kind,'paste');
 send(insertion.data);
 await new Promise(r=>setTimeout(r,1500));
 const files=await fs.readdir(join(dir,'qwen-runtime','tmp','clipboard')).catch(()=>[]);
 assert.equal(files.length,1, 'Qwen must promote the pasted path to an attachment');
 send('Describe the attached image.\r');
 const end=Date.now()+12000;while(!gotImage && Date.now()<end)await new Promise(r=>setTimeout(r,200));
 console.log(JSON.stringify({modelCalls,gotImage}));
 if(!gotImage){console.log(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-3500));throw new Error('Qwen did not transmit image');}
 console.log('PASS: real HTTP upload -> WebSocket bracketed paste -> real Qwen -> image_url to local mock provider. Decoded model payload matches the test image. No real model inference.');
}finally{
 // Qwen's launcher can spawn workers that outlive the PTY. Match this smoke's
 // unique local provider port before stopping only its own CLI processes.
 const {stdout}=await promisify(execFile)('ps',['-axo','pid=,args=']);
 const pids=stdout.split('\n').flatMap(line=>{
   const match=line.trim().match(/^(\d+)\s+(.*)$/);
   return match && match[2].includes('--model diy-vision-test') && match[2].includes(`--openai-base-url ${api}`) ? [Number(match[1])] : [];
 });
 for(const pid of pids)try{process.kill(pid,'SIGTERM')}catch{}
 await new Promise(r=>setTimeout(r,300));
 for(const pid of pids)try{process.kill(pid,0);process.kill(pid,'SIGKILL')}catch{}
 ws?.terminate();server.closeAllConnections();await new Promise(r=>server.close(r));runtime.dispose();store.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
