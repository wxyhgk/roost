/*
  换绑的重试。

  这不是「顺手加上更稳妥」——是 2026-09-22 手工调接口时**真的撞到**的：第一次调用拿到
  409 `binding version changed`，量了一下 `revision` 约每秒涨 1 次（transcript 摄取一直在
  往同一条记录上写），而一次换绑要走「读绑定 → 服务端读 PTY 日志核验身份 → 写入」整条链，
  几百毫秒足够它变一次。

  不重试的按钮会随机失败，而且抛给用户的是「binding version changed」这种他完全看不懂的话。
  所以这里钉的两件事是：**竞态要重试**，以及**别的错误绝不能重试**（重试一百次也一样，
  还会把真正的原因盖掉）。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { rebindWithRetry, MAX_ATTEMPTS } from '../src/features/conversations/rebind';
import { ApiError } from '../src/shared/api/errors';

const identity = { terminalInstanceId: 'i-live', cliId: 'claude', nativeSessionId: 'n-1' };
const binding = (revision: number) => ({
  binding: { webSessionId: 's', terminalInstanceId: 'i-old', cliId: 'claude',
    nativeSessionId: 'n-1', generation: 'g', revision },
});
const race = () => new ApiError(409, 'conflict', 'binding version changed', 'binding version changed', null);

test('一次就成：读一次版本，带着它写一次', async () => {
  const seen: unknown[] = [];
  const result = await rebindWithRetry({
    read: async () => binding(10),
    write: async body => { seen.push(body); return binding(11); },
    identity,
  });
  assert.equal(result.revision, 11);
  assert.deepEqual(seen, [{ expectedGeneration: 'g', expectedRevision: 10, ...identity }]);
});

test('版本被抢先就重来，而且**每一轮都重新读版本**', async () => {
  let revision = 10;
  const used: number[] = [];
  const result = await rebindWithRetry({
    read: async () => binding(revision),
    write: async body => {
      used.push(body.expectedRevision);
      // 前两次都被别人抢先：服务端那边 revision 已经往前走了。
      if (used.length < 3) { revision++; throw race(); }
      return binding(revision);
    },
    identity,
  });
  assert.equal(result.revision, 12);
  /*
    这条是重点：三次用的是 10/11/12，不是 10/10/10。拿上一轮那个过期版本去重试是没有
    意义的——它注定再输一次，重试次数用完还是失败。
  */
  assert.deepEqual(used, [10, 11, 12]);
});

test('不是版本竞态的 409 立刻抛出，一次都不重试', async () => {
  for (const error of [
    new ApiError(409, 'identity_unconfirmed', 'native identity not confirmed', 'native identity not confirmed', null),
    new ApiError(409, 'conflict', 'native session already bound', 'native session already bound', null),
  ]) {
    let writes = 0;
    await assert.rejects(
      rebindWithRetry({ read: async () => binding(1), write: async () => { writes++; throw error; }, identity }),
      (thrown: unknown) => thrown === error);
    assert.equal(writes, 1, `${error.code} 不该重试：情况确实不对，重试只会把原因盖掉`);
  }
});

test('非 409 原样抛出', async () => {
  const boom = new ApiError(503, 'storage_unavailable', 'nope', 'nope', null);
  let writes = 0;
  await assert.rejects(
    rebindWithRetry({ read: async () => binding(1), write: async () => { writes++; throw boom; }, identity }),
    (thrown: unknown) => thrown === boom);
  assert.equal(writes, 1);
});

test('一直被抢先：试满次数之后抛出最后那个竞态错误，不假装成功', async () => {
  let writes = 0;
  const failure = race();
  await assert.rejects(
    rebindWithRetry({ read: async () => binding(1), write: async () => { writes++; throw failure; }, identity, attempts: 3 }),
    (thrown: unknown) => thrown === failure);
  assert.equal(writes, 3);
});

test('默认次数是有限的——不能变成一个永不放弃的循环', () => {
  assert.ok(Number.isInteger(MAX_ATTEMPTS) && MAX_ATTEMPTS > 1 && MAX_ATTEMPTS <= 20);
});
