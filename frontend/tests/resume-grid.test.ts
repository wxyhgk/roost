import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { createResume } from '../src/features/terminal/resume';
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
