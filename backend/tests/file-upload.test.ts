import './helpers/fake-pty.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { uploadFile, MAX_UPLOAD_BYTES } from '../src/file-upload.ts';
import { listDir } from '../src/fs.ts';
const { createBackendServer } = await import('../src/server.ts');
const { createWorkspaceStore } = await import('@roost/workspace-store');
const { createTerminalRuntime } = await import('@roost/terminal-runtime');

async function root(t:TestContext) {
  const path=await mkdtemp(join(tmpdir(),'roost-upload-'));
  t.after(()=>rm(path,{recursive:true,force:true}));return path;
}
async function* bytes(value:Uint8Array) {yield value;}
async function fixture(t:TestContext) {
  const dir=await root(t),files=join(dir,'files');await mkdir(files);
  const store=createWorkspaceStore({dataDir:dir});
  store.upsertSession({id:'file-workspace',cwd:files});
  const runtime=createTerminalRuntime({defaultCwd:dir,shell:'/bin/sh',env:{},historyStore:store});
  const server=createBackendServer({ auth: false,store,runtime,workspaceRoot:files});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));runtime.dispose();store.close();});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const url=(path:string,conflict?:string)=>base+'/api/fs/file?'+new URLSearchParams({root:files,path,...(conflict?{conflict}:{})});
  return {files,base,url};
}
const temporaryFiles=async(dir:string)=>(await readdir(dir)).filter(name=>name.startsWith('.diy-upload-'));
async function until(check:()=>Promise<boolean>) {for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('condition timed out');}

test('binary bytes stream into a hidden staging file and appear only when complete',async t=>{
  const dir=await root(t),value=Buffer.from([0,255,10,128,1]);
  async function* source(){yield value.subarray(0,2);assert.deepEqual(await listDir(dir),[]);await assert.rejects(stat(join(dir,'a.bin')));yield value.subarray(2);}
  const result=await uploadFile(dir,'a.bin',source());
  assert.equal(result.size,value.length);assert.equal(result.overwritten,false);
  assert.deepEqual(await readFile(join(dir,'a.bin')),value);
  assert.deepEqual(await temporaryFiles(dir),[]);
  const empty=await uploadFile(dir,'empty',bytes(Buffer.alloc(0)));assert.equal(empty.size,0);
});

test('failed, aborted and oversized streams leave no partial destination or staging file',async t=>{
  const dir=await root(t);
  async function* failing(){yield Buffer.from('partial');throw new Error('source failed');}
  await assert.rejects(uploadFile(dir,'failed',failing()),/source failed/);
  const controller=new AbortController();
  async function* aborted(){yield Buffer.from('partial');controller.abort();yield Buffer.from('rest');}
  await assert.rejects(uploadFile(dir,'aborted',aborted(),'error',controller.signal));
  const chunk=Buffer.alloc(1024*1024,7);
  async function* oversized(){for(let i=0;i<64;i++)yield chunk;yield Buffer.from([1]);}
  await assert.rejects(uploadFile(dir,'large',oversized()),(e:any)=>e.status===413);
  assert.deepEqual(await readdir(dir),[]);
  async function* exact(){for(let i=0;i<64;i++)yield chunk;}
  const result=await uploadFile(dir,'exact',exact());
  assert.equal(result.size,MAX_UPLOAD_BYTES);assert.equal((await stat(join(dir,'exact'))).size,MAX_UPLOAD_BYTES);
});

test('conflict policies never silently overwrite and concurrent create has one winner',async t=>{
  const dir=await root(t);await writeFile(join(dir,'report.pdf'),'original');
  await assert.rejects(uploadFile(dir,'report.pdf',bytes(Buffer.from('new'))),(e:any)=>e.status===409);
  const renamed=await uploadFile(dir,'report.pdf',bytes(Buffer.from('copy')),'rename');
  assert.equal(renamed.path,'report-1.pdf');assert.equal(await readFile(join(dir,'report.pdf'),'utf8'),'original');
  const overwritten=await uploadFile(dir,'report.pdf',bytes(Buffer.from('replace')),'overwrite');
  assert.equal(overwritten.overwritten,true);assert.equal(await readFile(join(dir,'report.pdf'),'utf8'),'replace');
  async function* race(){yield Buffer.from('upload');await writeFile(join(dir,'report.pdf'),'external update');}
  await assert.rejects(uploadFile(dir,'report.pdf',race(),'overwrite'),(e:any)=>e.status===409);
  assert.equal(await readFile(join(dir,'report.pdf'),'utf8'),'external update');
  const results=await Promise.allSettled([uploadFile(dir,'race',bytes(Buffer.from('one'))),uploadFile(dir,'race',bytes(Buffer.from('two')))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  assert.deepEqual(await temporaryFiles(dir),[]);
});

test('path escape, symlink parents and non-file overwrite are rejected',async t=>{
  const dir=await root(t),outside=await root(t);await symlink(outside,join(dir,'link'));
  await assert.rejects(uploadFile(dir,'../escape',bytes(Buffer.from('x'))),/path escapes/);
  await assert.rejects(uploadFile(dir,'link/escape',bytes(Buffer.from('x'))),/path escapes/);
  await assert.rejects(uploadFile(dir,'.',bytes(Buffer.from('x'))));
  await assert.rejects(uploadFile(dir,'link',bytes(Buffer.from('x')),'overwrite'),(e:any)=>e.status===400);
  await assert.rejects(uploadFile(dir,'missing/file',bytes(Buffer.from('x'))));
  assert.deepEqual(await readdir(outside),[]);
});

test('raw HTTP route validates input, supports binary and returns structured conflict errors',async t=>{
  const f=await fixture(t),payload=Buffer.from([0,1,255,254]);
  let response=await fetch(f.url('image.bin'),{method:'POST',body:payload});
  assert.equal(response.status,201);assert.equal((await response.json()).size,4);
  assert.deepEqual(await readFile(join(f.files,'image.bin')),payload);
  response=await fetch(f.url('image.bin'),{method:'POST',body:payload});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'conflict');
  assert.equal((await fetch(f.url('image.bin','rename'),{method:'POST',body:payload})).status,201);
  assert.equal((await fetch(f.url('../escape'),{method:'POST',body:payload})).status,403);
  assert.equal((await fetch(f.url('x')+'&path=y',{method:'POST',body:payload})).status,400);
  assert.equal((await fetch(f.url('x','bad'),{method:'POST',body:payload})).status,400);
  assert.equal((await fetch(f.url('x'),{method:'POST',body:payload,headers:{'content-encoding':'gzip'}})).status,415);
  assert.equal((await fetch(f.url('x'))).status,405);
});

test('HTTP oversized declaration returns JSON 413 without waiting for the body',async t=>{
  const f=await fixture(t);
  const result=await new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=httpRequest(f.url('huge'),{method:'POST',headers:{'content-length':String(MAX_UPLOAD_BYTES+1)}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));
    });req.on('error',reject);req.flushHeaders();
  });
  assert.equal(result.status,413);assert.equal(result.body.error.code,'too_large');
  assert.deepEqual(await temporaryFiles(f.files),[]);
});

test('aborted HTTP uploads release staging files and concurrent writer slots',async t=>{
  const f=await fixture(t);
  const requests=Array.from({length:4},(_,i)=>{const req=httpRequest(f.url('pending'+i),{method:'POST',headers:{'transfer-encoding':'chunked'}});req.on('error',()=>{});req.write(Buffer.from('partial'));return req;});
  try {
    await until(async()=>(await temporaryFiles(f.files)).length===4);
    const busy=await fetch(f.url('busy'),{method:'POST',body:Buffer.from('data')});
    assert.equal(busy.status,429);assert.equal((await busy.json()).error.code,'upload_busy');
  }finally{for(const req of requests)req.destroy();}
  await until(async()=>(await temporaryFiles(f.files)).length===0);
  const retry=await fetch(f.url('retry'),{method:'POST',body:Buffer.from('complete')});assert.equal(retry.status,201);
  assert.deepEqual((await readdir(f.files)).sort(),['retry']);
});

test('chunked HTTP counts actual bytes and returns JSON 413 after cleaning staging',async t=>{
  const f=await fixture(t);
  const result=await new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=httpRequest(f.url('oversized.bin'),{method:'POST'},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));
    });
    req.on('error',reject);
    void(async()=>{
      const chunk=Buffer.alloc(1024*1024);
      for(let i=0;i<64;i++){if(!req.write(chunk))await once(req,'drain');}
      req.end(Buffer.from([1]));
    })().catch(reject);
  });
  assert.equal(result.status,413);assert.equal(result.body.error.code,'too_large');
  assert.deepEqual(await readdir(f.files),[]);
});

test('directory watcher publishes the finished upload without staging notifications',async t=>{
  const {createFileWatcher}=await import('../src/watcher.ts');
  const dir=await root(t),watcher=createFileWatcher({debounceMs:10});
  t.after(()=>watcher.dispose());let changes=0;
  watcher.watch(dir,()=>changes++);
  await new Promise(r=>setTimeout(r,350));changes=0;
  async function* source(){yield Buffer.from('first');await new Promise(r=>setTimeout(r,250));assert.equal(changes,0);yield Buffer.from('last');}
  await uploadFile(dir,'complete.txt',source());
  await until(async()=>changes>0);
  assert.equal(await readFile(join(dir,'complete.txt'),'utf8'),'firstlast');
});
