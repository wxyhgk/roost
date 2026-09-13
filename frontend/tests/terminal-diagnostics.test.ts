import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiagnosticTrace, stalledParser } from '../src/features/terminal/diagnostics.ts';
import { createResume } from '../src/features/terminal/resume.ts';
test('diagnostic history is bounded and callers cannot change saved events',()=>{
 const trace=createDiagnosticTrace(()=>123);for(let i=0;i<100;i++)trace.record('reconnect',i);
 const events=trace.read();assert.equal(events.length,40);assert.deepEqual(events[0],{at:123,event:'reconnect',value:60});events[0].event='changed';assert.equal(trace.read()[0].event,'reconnect');
});
test('quiet terminals and inactive panes are not mistaken for a stuck parser',()=>{
 assert.equal(stalledParser(0,null,100000,true,true),false);
 assert.equal(stalledParser(1,0,10001,false,true),false);
 assert.equal(stalledParser(1,0,10001,true,false),false);
 assert.equal(stalledParser(1,0,9999,true,true),false);
 assert.equal(stalledParser(1,0,10000,true,true),true);
 // 追上了就不该再报，哪怕之前落后过很久。
 assert.equal(stalledParser(0,0,999999,true,true),false);
 // 差距很大但刚出现，还不到门槛。
 assert.equal(stalledParser(5000,9000,10000,true,true),false);
});
test('diagnostics distinguish received bytes from parsed cursor; disposing releases stuck writes and queued prepare',async()=>{
 let finish!:()=>void;const resume=createResume({write(_data,done){finish=done},reset(){},snapshot:()=>null});
 await resume.prepare('one',null);
 const replay=resume.accept({type:'replay',instanceId:'one',seq:9,data:'private output should not be in diagnostic data'});
 await new Promise(r=>setImmediate(r));
 assert.equal(resume.inspect().received,9);assert.equal(resume.inspect().applied,0);assert.equal(resume.inspect().pendingWrites,1);
 assert.equal(JSON.stringify(resume.inspect()).includes('private output'),false);
 const reconnect=resume.prepare('one',null);resume.dispose();await replay.done;assert.equal(await reconnect,undefined);
 assert.equal(resume.inspect().pendingWrites,0);assert.equal(resume.inspect().valid,false);finish();assert.equal(resume.inspect().pendingWrites,0);
 assert.equal(resume.inspect().applied,0);
});

/*
  这条守的是判据本身，不是阈值。

  原来卡顿检测看的是 `pendingWrites`，而所有写都排在同一条 FIFO 队列上依次执行——
  它永远只能是 0 或 1，每一批最多 256KB、几毫秒写完。于是**洪流期间终端落后再多，
  检测也永远不会触发**。真正会涨的是「已收到的序号减去已写入的序号」。
*/
test('a terminal falling further behind is reported, however small the write queue stays', () => {
  const start = 1_000_000;
  // 一次洪流：落后 4000 帧，而同一时刻队列上只有一次写在跑。
  const behind = 4000, pendingWrites = 1;
  assert.equal(stalledParser(behind, start, start + 9_999, true, true), false);
  assert.equal(stalledParser(behind, start, start + 10_000, true, true), true);
  // 拿旧判据（队列深度）去问，无论过多久都报不出来——那正是被修掉的东西。
  assert.equal(pendingWrites > 1, false);
});
