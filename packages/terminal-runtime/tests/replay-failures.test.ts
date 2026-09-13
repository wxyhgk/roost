import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplayStore, FLUSH_JITTER, FLUSH_MS } from '../src/replay.ts';

/*
  第一次落盘是**带抖动**的（多会话同时出输出时不让定时器撞在一个 tick 上），
  所以这里推进到抖动的上界而不是 FLUSH_MS。这两条测试要验的是「失败之后保持脏、
  按精确的退避表重试」——退避那一段刻意没有抖动，下面逐档的 tick 仍然是精确的。
*/
const FIRST_FLUSH_BY = Math.ceil(FLUSH_MS * (1 + FLUSH_JITTER));
import { createScreenStore } from '../src/screen.ts';

test('background save failure stays dirty and retries without losing newer output', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'info', () => {});
  let broken = true; let attempts = 0; let persisted = '';
  const replay = createReplayStore({ getTerminalReplay: () => null, deleteTerminalReplay: () => {}, setTerminalReplay: (_id, _raw, _snap, state) => {
    attempts++; if (broken) throw Error('private details should not be logged'); persisted = state!;
  } });
  t.after(() => replay.dispose());
  replay.hydrate('s'); replay.append('s', 'A');
  assert.doesNotThrow(() => t.mock.timers.tick(FIRST_FLUSH_BY)); assert.equal(attempts, 1);
  replay.append('s', 'B'); t.mock.timers.tick(2999); assert.equal(attempts, 1);
  broken = false; t.mock.timers.tick(1); assert.equal(attempts, 2);
  assert.equal(JSON.parse(persisted).chunks.map((c: {data:string}) => c.data).join(''), 'AB');
  assert.equal(replay.flush('s'), true); assert.equal(attempts, 2);
  assert.equal(errors.mock.calls.length, 1);
  assert.ok(!JSON.stringify(errors.mock.calls[0].arguments).includes('private details'));
});

test('persistent failure backs off to a capped retry interval and does not block other sessions', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const attempts = new Map<string, number>();
  const replay = createReplayStore({ getTerminalReplay: () => null, deleteTerminalReplay: () => {}, setTerminalReplay: id => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1); if (id === 'bad') throw Error('offline');
  } });
  replay.hydrate('bad'); replay.hydrate('good'); replay.append('bad', 'A'); replay.append('good', 'B');
  t.mock.timers.tick(FIRST_FLUSH_BY); assert.equal(attempts.get('bad'), 1); assert.equal(attempts.get('good'), 1);
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    const before = attempts.get('bad'); replay.append('bad', 'new');
    t.mock.timers.tick(delay - 1); assert.equal(attempts.get('bad'), before);
    t.mock.timers.tick(1); assert.equal(attempts.get('bad'), before! + 1);
  }
  replay.append('good', 'LATEST'); replay.dispose();
  assert.equal(attempts.get('good'), 2);
  const before = attempts.get('bad'); t.mock.timers.tick(100_000); assert.equal(attempts.get('bad'), before);
});

test('failed exit saves retry after detachment and immediate reopen retains unsaved history', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'info', () => {});
  let broken = true; const rows = new Map<string, {raw:string;snapshot:null;stateJson:string}>();
  const replay = createReplayStore({ getTerminalReplay: id => rows.get(id), deleteTerminalReplay: () => {}, setTerminalReplay: (id, raw, _snap, state) => {
    if (broken) throw Error('offline'); rows.set(id, { raw, snapshot: null, stateJson: state! });
  } });
  t.after(() => replay.dispose());
  replay.hydrate('late'); replay.append('late', 'EXIT OUTPUT'); replay.detach('late');
  assert.ok(replay.resume('late')?.data.includes('EXIT OUTPUT'));
  broken = false; t.mock.timers.tick(3000); assert.ok(rows.has('late')); assert.equal(replay.resume('late'), null);
  broken = true; replay.hydrate('restart'); const old = replay.getInstanceId('restart');
  replay.append('restart', '\x1b[?1003;1006hUNSAVED'); replay.detach('restart'); replay.hydrate('restart');
  assert.notEqual(replay.getInstanceId('restart'), old); assert.ok(replay.resume('restart')?.data.includes('UNSAVED'));
  broken = false; t.mock.timers.tick(3000); assert.ok(rows.has('restart'));
});

test('a real timer storage exception does not terminate its Node process', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createReplayStore } from './src/replay.ts';
    const replay = createReplayStore({getTerminalReplay:()=>null,deleteTerminalReplay:()=>{},setTerminalReplay:()=>{throw Error('storage offline')}});
    replay.hydrate('s'); replay.append('s','history');
    setTimeout(()=>{ if(!replay.resume('s')?.data.includes('history')) process.exitCode=1; replay.dispose(); console.log('ALIVE'); },1700);
  `], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ALIVE/);
  assert.match(result.stderr, /save failed/); assert.ok(!result.stderr.includes('Error: storage offline'));
});

test('repeated reopen during a storage outage keeps carried history bounded and reports truncation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.method(console, 'error', () => {});
  const replay = createReplayStore({ getTerminalReplay: () => null, deleteTerminalReplay: () => {}, setTerminalReplay: () => { throw Error('offline'); } });
  t.after(() => replay.dispose()); replay.hydrate('s');
  for (let i = 0; i < 4; i++) {
    replay.append('s', 'x'.repeat(600_000)); replay.detach('s'); replay.hydrate('s');
    const frame = replay.resume('s')!;
    assert.ok(frame.data.length < 2_001_000); assert.equal(frame.truncated, true);
  }
});

/*
  重连要还原的是**当前画面**，不是走到那里的路径。

  以前只能把原始历史发回去让浏览器重跑一遍折叠——而浏览器里唯一能跑折叠的地方就是
  用户正看着的那个终端，所以他会看着历史滚过去。有了服务端网格，同一个问题变成一次
  内存读取。
*/
test('a full resume restores the current screen instead of replaying how it got there', async () => {
  const rows = new Map<string, { raw: string; snapshot: string | null }>();
  const screen = createScreenStore();
  const replay = createReplayStore({
    getTerminalReplay: id => rows.get(id) ?? null,
    setTerminalReplay: (id, raw, snap) => { rows.set(id, { raw, snapshot: snap }); },
    deleteTerminalReplay: id => { rows.delete(id); },
  }, screen);

  replay.hydrate('s');
  const instanceId = replay.getInstanceId('s')!;
  for (let i = 1; i <= 200; i++) {
    const chunk = replay.append('s', `\x1b[H\x1b[2Jstep ${i}\r\n`)!;
    screen.write('s', instanceId, chunk.data, chunk.seq, 80, 24);
  }
  /*
    等解析**确实追到了第 200 块**，而不是等一个大概够用的毫秒数。xterm 的 write 是异步的，
    30ms 在这台机器上正好卡在边界：单独跑这个文件会红，整包跑反而过——这种测试红得看不出原因。
  */
  for (let i = 0; i < 500 && (screen.snapshot('s')?.seq ?? -1) < 200; i++)
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  assert.equal(screen.snapshot('s')?.seq, 200, '网格没解析完，后面的断言都无从谈起');

  const payload = replay.resume('s');
  assert.ok(payload);
  assert.equal(payload.type, 'replay');
  assert.match(payload.data, /step 200/, 'the restored screen must show where the terminal actually is');
  assert.doesNotMatch(payload.data, /step 100/, 'it must not carry the path it took to get there');
  assert.equal(payload.truncated, false, 'a restored screen is complete; only older scrollback is missing');

  // 网格拿不到时仍然退回旧路径，两条并存。
  screen.drop('s');
  const fallback = replay.resume('s');
  assert.ok(fallback);
  assert.match(fallback.data, /step 200/);
  assert.ok(fallback.data.length > payload.data.length, 'the fallback carries the raw history it always did');
  replay.dispose();
  screen.dispose();
});
