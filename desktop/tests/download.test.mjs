import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { download } from '../scripts/lib/node-runtime.mjs';

/*
  运行时归档是每次 CI 都真的走网络的一次 ~30MB 下载（归档没有缓存）。原来只试一次，
  于是 runner 上一次瞬时的 `fetch failed` 就让整条流水线变红——和被构建的代码毫无关系。
  这组用例钉住重试的边界：什么情况重试、什么情况立刻放弃、以及最多试几次。

  `wait` 是注入的，所以测试不会真的睡 1+2+4 秒。
*/
const body = Buffer.from('runtime archive');
const digest = createHash('sha256').update(body).digest('hex');
const ok = () => ({ ok: true, status: 200, arrayBuffer: async () => body });
const status = code => ({ ok: false, status: code });
const skipWait = () => Promise.resolve();

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(url);
    const next = responses[calls.length - 1];
    if (typeof next === 'function') return next();
    throw next;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('一次成功就返回，不重试', async () => {
  const stub = stubFetch([ok]);
  try {
    assert.deepEqual(await download('https://example/archive', digest, 4, skipWait), body);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

/* 这正是 CI 红掉的那次：fetch 直接抛，和被构建的代码无关。 */
test('网络抛错会重试，之后成功', async () => {
  const stub = stubFetch([Error('fetch failed'), Error('fetch failed'), ok]);
  try {
    assert.deepEqual(await download('https://example/archive', digest, 4, skipWait), body);
    assert.equal(stub.calls.length, 3);
  } finally { stub.restore(); }
});

test('一直失败则报最后一个错，且不超过上限', async () => {
  const stub = stubFetch(Array(9).fill(Error('fetch failed')));
  try {
    await assert.rejects(download('https://example/archive', digest, 4, skipWait), /fetch failed/);
    assert.equal(stub.calls.length, 4, 'CI 的价值是快速给答案，不能无限重试');
  } finally { stub.restore(); }
});

/* 5xx 是对面的问题，可能过一会儿就好；4xx 是我们把版本号或文件名写错了。 */
test('5xx 重试，4xx 立刻放弃', async () => {
  const server = stubFetch([() => status(503), ok]);
  try {
    assert.deepEqual(await download('https://example/archive', digest, 4, skipWait), body);
    assert.equal(server.calls.length, 2);
  } finally { server.restore(); }

  const missing = stubFetch(Array(4).fill(() => status(404)));
  try {
    await assert.rejects(download('https://example/archive', digest, 4, skipWait), /failed: 404/);
    assert.equal(missing.calls.length, 1, '404 重试没有意义');
  } finally { missing.restore(); }
});

/*
  截断的响应表现为校验不过，而那是瞬时故障的样子，所以要重试。
  锁文件里的 sha256 写错的话重试也过不了，最终照样报出来——这条同时钉住「坏内容不会
  被当成成功返回」。
*/
test('校验不过会重试；始终不过则报校验错误', async () => {
  const truncated = () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('half') });
  const recovering = stubFetch([truncated, ok]);
  try {
    assert.deepEqual(await download('https://example/archive', digest, 4, skipWait), body);
    assert.equal(recovering.calls.length, 2);
  } finally { recovering.restore(); }

  const wrong = stubFetch(Array(4).fill(truncated));
  try {
    await assert.rejects(download('https://example/archive', digest, 4, skipWait), /checksum mismatch/);
    assert.equal(wrong.calls.length, 4);
  } finally { wrong.restore(); }
});
