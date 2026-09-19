/*
  自己写的密码学实现必须有一条和权威实现对账的测试，否则它只是「看起来像」。

  这里拿 Node 的 `crypto` 逐个比：随机输入、所有会踩到填充边界的长度、以及 HMAC 里
  「密钥比分组长」那条分支。对不上就红。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { sha256, hmacSha256, pbkdf2Sha256 } from '../src/sha256.ts';
import { solveChallenge, toBase64Url, fromBase64Url, utf8, CHALLENGE_ITERATIONS, MIN_ITERATIONS } from '../src/index.ts';

const same = (mine: Uint8Array, theirs: Buffer, what: string) =>
  assert.equal(Buffer.from(mine).toString('hex'), theirs.toString('hex'), what);

/* 55/56/57 和 63/64/65 是填充规则换分支的地方，长度刚好跨过去时最容易写错。 */
test('SHA-256 和 Node 一致，包括填充的每一条边界', () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000]) {
    const data = randomBytes(length);
    same(sha256(data), createHash('sha256').update(data).digest(), `长度 ${length}`);
  }
});

test('HMAC-SHA256 和 Node 一致，包括密钥比分组长的那条分支', () => {
  for (const [keyLength, messageLength] of [[0, 0], [1, 1], [32, 10], [64, 64], [65, 200], [200, 5]]) {
    const key = randomBytes(keyLength), message = randomBytes(messageLength);
    same(hmacSha256(key, message), createHmac('sha256', key).update(message).digest(), `密钥 ${keyLength} 消息 ${messageLength}`);
  }
});

/* 用标准而不是自己发明哈希链，图的就是这条能对账。 */
test('PBKDF2-HMAC-SHA256 和 Node 一致', () => {
  for (const iterations of [1, 2, 1000, 4096]) {
    const password = randomBytes(12), salt = randomBytes(32);
    same(pbkdf2Sha256(password, salt, iterations), pbkdf2Sync(password, salt, iterations, 32, 'sha256'), `${iterations} 次`);
  }
});

test('base64url 往返，且不带填充等号', () => {
  for (const length of [0, 1, 2, 3, 32, 33]) {
    const bytes = randomBytes(length);
    const text = toBase64Url(bytes);
    assert.ok(!text.includes('='), '不该有填充');
    assert.ok(!/[+/]/.test(text), '不该有 + 和 /');
    assert.deepEqual([...fromBase64Url(text)], [...bytes], `长度 ${length}`);
  }
});

test('应答就是 HMAC(PBKDF2(密码, 盐), 随机数)，服务端用 Node 算得出同一个值', () => {
  const salt = randomBytes(32), nonce = randomBytes(32);
  const challenge = { salt: toBase64Url(salt), nonce: toBase64Url(nonce), iterations: MIN_ITERATIONS };
  const mine = solveChallenge('correct horse battery staple', challenge);
  const key = pbkdf2Sync(Buffer.from('correct horse battery staple', 'utf8'), salt, MIN_ITERATIONS, 32, 'sha256');
  const theirs = createHmac('sha256', key).update(nonce).digest();
  assert.equal(mine, toBase64Url(theirs), '两边必须用同一个标准算出同一个值，否则登录永远失败');
});

test('非 ASCII 密码按 UTF-8 编码，和服务端的 Buffer.from(…, "utf8") 对得上', () => {
  const salt = randomBytes(32), nonce = randomBytes(32);
  const password = '密码🔒with spaces';
  const mine = solveChallenge(password, { salt: toBase64Url(salt), nonce: toBase64Url(nonce), iterations: MIN_ITERATIONS });
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, MIN_ITERATIONS, 32, 'sha256');
  assert.equal(mine, toBase64Url(createHmac('sha256', key).update(nonce).digest()));
});

/*
  迭代次数是服务端下发的，所以它是一个可以被改小的值。改小到一定程度，离线爆破就
  变成免费的——客户端必须自己拒绝，而不是「对方说多少就算多少」。
*/
test('迭代次数被压低时直接抛错，不是尽力而为', () => {
  const challenge = { salt: toBase64Url(randomBytes(32)), nonce: toBase64Url(randomBytes(32)), iterations: 1 };
  assert.throws(() => solveChallenge('whatever', challenge), /iterations/);
  assert.throws(() => solveChallenge('whatever', { ...challenge, iterations: MIN_ITERATIONS - 1 }), /iterations/);
  assert.ok(CHALLENGE_ITERATIONS >= MIN_ITERATIONS, '默认值不能低于自己设的下限');
});

/*
  三个编码函数是自己写的（为了不把 DOM / Node 的类型拉进这个纯包），所以同样要和
  Node 的 `Buffer` 对账——尤其 UTF-8：服务端那边用的就是 `Buffer.from(s, "utf8")`，
  差一个字节，登录就永远失败，而且错得毫无提示。
*/
test('UTF-8 编码和 Node 的 Buffer 一致，含多字节、emoji 和落单的代理对', () => {
  const cases = ['', 'ascii', '密码', 'a密b', '🔒', '🔒🔑', 'é', '\u{10FFFF}', '\ud83d', 'x\udc00y'];
  for (const text of cases) {
    assert.equal(Buffer.from(utf8(text)).toString('hex'), Buffer.from(text, 'utf8').toString('hex'), JSON.stringify(text));
  }
});

test('base64url 和 Node 的 base64url 一致', () => {
  for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 64]) {
    const bytes = randomBytes(length);
    assert.equal(toBase64Url(bytes), bytes.toString('base64url'), `长度 ${length}`);
    assert.equal(Buffer.from(fromBase64Url(bytes.toString('base64url'))).toString('hex'), bytes.toString('hex'));
  }
  // 带填充等号的标准 base64url 也要能读回来：别人拿 Node 编出来的可能带 =。
  const padded = Buffer.from('hello').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  assert.equal(Buffer.from(fromBase64Url(padded)).toString(), 'hello');
});
