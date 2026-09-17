import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { createResume } from '../src/features/terminal/session/resume';
const {Terminal}=headless;
const write=(term:InstanceType<typeof Terminal>,data:string)=>new Promise<void>(resolve=>term.write(data,resolve));
const lines=(term:InstanceType<typeof Terminal>)=>Array.from({length:term.rows},(_,row)=>term.buffer.active.getLine(term.buffer.active.baseY+row)?.translateToString(true));
for(const explicit of [false,true]) test(`refresh restores the original grid before parsing a full-screen snapshot (${explicit?'frame dimensions':'legacy hello dimensions'})`,async t=>{
 const source=new Terminal({cols:80,rows:24,allowProposedApi:true}),destination=new Terminal({cols:60,rows:18,allowProposedApi:true});
 const serializer=new SerializeAddon();source.loadAddon(serializer);
 t.after(()=>{source.dispose();destination.dispose();});
 await write(source,'\x1b[?1049h\x1b[1;1HHEADER\x1b[22;1HINPUT\x1b[23;1HBOTTOM_BORDER\x1b[24;1HSTATUS\x1b[22;7H');
 const resume=createResume({get cols(){return destination.cols;},get rows(){return destination.rows;},resize:(cols,rows)=>destination.resize(cols,rows),reset:()=>destination.reset(),snapshot:()=>null,write:(data,done)=>destination.write(data,done)});
 t.after(()=>resume.dispose());
 await resume.prepare('pty',null,false,explicit?{cols:60,rows:18}:{cols:80,rows:24});
 await resume.accept({type:'replay',instanceId:'pty',seq:1,data:serializer.serialize(),...(explicit?{cols:80,rows:24}:{})}).done;
 assert.deepEqual(lines(destination),lines(source));assert.equal(destination.buffer.active.cursorY,source.buffer.active.cursorY);
 await resume.accept({type:'output',instanceId:'pty',seq:2,data:'tail'}).done;
 assert.equal(destination.cols,80);assert.equal(destination.rows,24);
});
test('a cached snapshot at an old grid cannot request an incremental catchup after the shared PTY changes size',async()=>{
 let writes=0;
 const resume=createResume({cols:80,rows:24,reset(){},write(_data,done){writes++;done();},snapshot:()=>null});
 try{assert.equal(await resume.prepare('pty',{instanceId:'pty',seq:4,data:'old',cols:80,rows:24},false,{cols:100,rows:30}),undefined);assert.equal(writes,0);}finally{resume.dispose();}
});
test('locally captured snapshots preserve their parser dimensions',async()=>{
 const resume=createResume({cols:100,rows:30,reset(){},write(_data,done){done();},snapshot:()=>'screen'});
 try{await resume.prepare('pty',null);await resume.accept({type:'replay',instanceId:'pty',seq:2,data:'screen'}).done;assert.deepEqual(await resume.snapshot(),{instanceId:'pty',seq:2,data:'screen',cols:100,rows:30});}finally{resume.dispose();}
});
/*
  同一个场景，守护进程会在增量里带几何切换点时：**缓存不该再被判废**。

  判废的理由是「缓存按旧宽度排，增量按新宽度来，硬接会画花」。增量自带切换点之后这个
  前提就没了——旧宽度那截仍按旧宽度解析，到标记那一刀才改网格。而判废的代价是走全量
  重建：服务端只留 2000 行、浏览器留 20000 行，中间那段只有浏览器有的历史当场消失
  （真机实测一次重连丢 2060 行，同一个会话里发生了两次）。
*/
test('守护进程带几何切换点时，网格对不上也照样用缓存续传',async()=>{
 let writes=0;
 const resume=createResume({cols:80,rows:24,resize(){},reset(){},write(_data,done){writes++;done();},snapshot:()=>null});
 try{
  const applied=await resume.prepare('pty',{instanceId:'pty',seq:4,data:'old',cols:80,rows:24},false,{cols:100,rows:30},true);
  assert.equal(applied,4,'应该从缓存的 seq 接着走，而不是回到全量重建');
  assert.equal(writes,1,'缓存那一屏要真的写进去');
 }finally{resume.dispose();}
});
