import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResume } from '../src/features/terminal/session/resume';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function terminal() {
  const frozen: boolean[] = [], writes: { data: string; done: () => void }[] = [];
  const resume = createResume({ write(data, done) { writes.push({ data, done }); }, reset() {}, snapshot: () => null, setFrozen(value) { frozen.push(value); } });
  return { resume, frozen, writes, finish() { const write = writes.shift(); assert.ok(write); write.done(); return write.data; } };
}

test('repeated large live bursts stay visible and only advance cursor after parsing', async () => {
  const t = terminal();
  await t.resume.prepare('a', null);
  await t.resume.accept({ type: 'replay', instanceId: 'a', seq: 0, data: '' }).done;
  t.frozen.length = 0;
  for (let seq = 1; seq <= 3; seq++) {
    const data = '中文 output '.repeat(50000);
    const frame = t.resume.accept({ type: 'output', instanceId: 'a', seq, data });
    await tick();
    assert.equal(t.resume.inspect().applied, seq - 1);
    assert.equal(t.frozen.includes(true), false);
    assert.equal(t.finish(), data);
    await frame.done;
    assert.equal(t.resume.inspect().applied, seq);
  }
  assert.equal(t.frozen.includes(true), false);
  t.resume.dispose();
});

test('large catchup stays visible; live output cannot extend full replay hiding', async () => {
  const t = terminal();
  await t.resume.prepare('a', null);
  const replay = t.resume.accept({ type: 'replay', instanceId: 'a', seq: 1, data: 'history' });
  await tick();
  const live = t.resume.accept({ type: 'output', instanceId: 'a', seq: 2, data: 'x'.repeat(300000) });
  assert.equal(t.frozen.at(-1), true);
  t.finish(); await replay.done; await tick();
  assert.equal(t.frozen.at(-1), false);
  t.finish(); await live.done;
  t.frozen.length = 0;
  const catchup = t.resume.accept({ type: 'catchup', instanceId: 'a', seq: 3, data: 'y'.repeat(300000) });
  await tick();
  assert.equal(t.frozen.includes(true), false);
  t.finish(); await catchup.done;
  t.resume.dispose();
});

test('stalled full replay still has a bounded hiding deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let frozen = false;
  let finish: (() => void) | undefined;
  const resume = createResume({ reset() {}, snapshot: () => null, write(_data, done) { finish = done; }, setFrozen(value) { frozen = value; } }, { maxFrozenMs: 100 });
  await resume.prepare('a', null);
  const frame = resume.accept({ type: 'replay', instanceId: 'a', seq: 1, data: 'history' });
  await tick(); assert.equal(frozen, true);
  t.mock.timers.tick(100); assert.equal(frozen, false);
  finish?.(); await frame.done;
  resume.dispose(); assert.equal(frozen, false);
});
