import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readServices } from '../src/services.ts';

test('an empty successful systemctl result is retried once, with a bounded failure if still empty', async () => {
  let calls = 0;
  const execute = async () => ++calls === 2 ? 'Id=caddy.service\nActiveState=active\n' : '';
  assert.equal((await readServices(['caddy.service'], execute))[0].active, 'active');
  assert.equal(calls, 2);
  await assert.rejects(readServices(['caddy.service'], execute), /Incomplete/);
  assert.equal(calls, 4);
});
test('service command failures are not retried and cannot become an empty healthy sample', async () => {
  let calls = 0;
  await assert.rejects(readServices(['caddy.service'], async () => { calls++; throw new Error('command timeout'); }), /command timeout/);
  assert.equal(calls, 1);
});
