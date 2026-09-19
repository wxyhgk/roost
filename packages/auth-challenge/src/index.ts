/*
  登录时不让密码上网。

  Roost 常常跑在明文 HTTP 上（自己的机器、局域网、不想折腾证书）。那种链路上，
  原来的登录是把密码明文 POST 上去的——路径上任何人抓一个包就拿到了它。

  这里换成挑战-响应：服务端先给一个一次性随机数，浏览器发的是
  `HMAC(由密码派生的密钥, 随机数)`。**密码一个字节都不上网。**

  ## 它解决什么，不解决什么

  解决的是**密码本身**泄露：嗅到的只是「一个随机数 + 一段哈希」，随机数用一次就作废，
  重放没用。你那个密码大概率在别处也用着，这一条是冲着那件事去的。

  **不解决会话劫持。** 登录成功之后的 session token 每个请求都在明文里发，抓到它就能
  跑命令。纯 HTTP 下这件事无解——真要解决只能让传输本身加密（TLS、WireGuard、SSH 隧道）。
  别把这个模块当成「HTTP 也安全了」。

  ## 代价换算

  它把「当场读到密码」变成了「拿回去离线爆破」。所以**它的价值等于密码的强度**：
  随机长密码 → 基本等于解决；生日加名字 → 只是拖慢几个小时。派生用 PBKDF2 迭代
  就是为了把这个「几个小时」乘上一个常数，但常数救不了一个弱密码。

  ## 为什么是自己实现的哈希

  `crypto.subtle` 只在「可信来源」下存在，而 HTTP 的 IP 地址不是可信来源——恰恰在最需要
  它的场景里它不存在。所以 sha256.ts 是一份纯 JS 实现，并且在测试里逐个和 Node 的
  `crypto` 对账。

  ## 为什么服务端那一侧不用这份实现

  服务端直接用 Node 的 `crypto.pbkdf2` / `createHmac`。用同一个**标准**而不是同一份
  代码，两边天然一致，而且这份 JS 实现有了一个权威的对照物。
*/

import { hmacSha256, pbkdf2Sha256 } from "./sha256.ts";

export { sha256, hmacSha256, pbkdf2Sha256 } from "./sha256.ts";

/**
 * 派生密钥的迭代次数。
 *
 * 实测这份纯 JS 实现约 100k 次 ≈ 290ms（台式 V8），手机上按三到五倍估。登录是十二小时
 * 一次的事，这个代价换的是离线爆破的成本，划算。
 *
 * **服务端在挑战里把它发下来**，所以调这个数不需要动客户端；客户端只拒绝低于
 * `MIN_ITERATIONS` 的值，免得一次静默的降级把派生变成免费的。
 */
export const CHALLENGE_ITERATIONS = 200_000;
export const MIN_ITERATIONS = 50_000;

/** 挑战多久作废。够慢的手机算完，又短到抓包的人来不及慢慢琢磨。 */
export const CHALLENGE_TTL_MS = 120_000;

export type LoginChallenge = {
  /** 一次性随机数，同时也是这次挑战的身份。base64url。 */
  nonce: string;
  /** 派生用的盐。公开值，跟着挑战一起下发。base64url。 */
  salt: string;
  iterations: number;
};

/*
  编码这三件事全部自己实现，一个全局都不碰。

  `TextEncoder` / `btoa` / `atob` 在 Node 和浏览器里其实都有，但一旦用了它们，这个包的
  类型就得把 DOM 或 Node 的声明拉进来——那正是隔壁几个纯包（cli-adapters、
  terminal-protocol）刻意不做的事。而且这三段加起来也就三十行，还都在测试里和 Node 的
  `Buffer` 对过账。
*/

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** UTF-8 编码。落单的代理对按 U+FFFD 处理，和 Node 的 `Buffer.from(s, "utf8")` 一致。 */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); i++; }
      else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;

    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0b111111];
  }
  return out;
}

/** 认不出的字符（填充的等号、空白）直接跳过，不因此报错。 */
export function fromBase64Url(text: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let bits = 0, value = 0, length = 0;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) continue;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[length++] = (value >> bits) & 0xff; }
  }
  return out.slice(0, length);
}

/**
 * 算出这次挑战的应答。**纯函数**，不碰网络，也不知道密码从哪来。
 *
 * 抛错而不是返回空：迭代次数被压低是降级攻击的样子，不是一个可以「尽力而为」的情况。
 */
export function solveChallenge(password: string, challenge: LoginChallenge): string {
  if (!Number.isSafeInteger(challenge.iterations) || challenge.iterations < MIN_ITERATIONS) {
    throw new Error("login challenge asked for too few iterations");
  }
  const key = pbkdf2Sha256(utf8(password), fromBase64Url(challenge.salt), challenge.iterations);
  return toBase64Url(hmacSha256(key, fromBase64Url(challenge.nonce)));
}
