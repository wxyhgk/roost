/*
  接管来的 PTY：拿一个裸 fd 拼出 runtime 认识的形状。

  测法不用 execve，也不起子进程——`node-pty` 的 `native.open()` 直接给一对真的
  master/slave fd。这样测到的是**真的 tty 系统调用**（读、写、ioctl 改尺寸），
  而不是替身；同时避开了可行性实测里踩的那个坑：同一个进程里两个读者抢同一个 fd。
  见 tasks/daemon-handoff/feasibility.md。
*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSync, readSync, writeSync } from 'node:fs';
import pty from 'node-pty';
import { adoptPty } from '../src/adopted-pty.ts';

const native = (pty as unknown as { native: { open(cols: number, rows: number): { master: number; slave: number; pty: string }; resize(fd: number, cols: number, rows: number): void } }).native;
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function pair(cols = 80, rows = 24) {
  const opened = native.open(cols, rows);
  return { ...opened, closeSlave: () => { try { closeSync(opened.slave); } catch { /* 已经关了。 */ } } };
}

test('从 slave 写进来的字节会变成 onData', async (t) => {
  const p = pair();
  const adopted = adoptPty({ fd: p.master, pid: process.pid, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => { adopted.kill('SIGCONT'); p.closeSlave(); });
  const seen: string[] = [];
  adopted.onData(chunk => seen.push(chunk));
  writeSync(p.slave, 'hello-from-slave');
  await tick();
  assert.equal(seen.join(''), 'hello-from-slave');
});

test('write 真的送到 slave 那一端', async (t) => {
  const p = pair();
  const adopted = adoptPty({ fd: p.master, pid: process.pid, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => { adopted.kill('SIGCONT'); p.closeSlave(); });
  // 两个坑：slave fd 是非阻塞的（readSync 直接 EAGAIN，要用 tty 流），而且行规程默认是
  // 规范模式——没有换行符的话字节停在行缓冲里不往上交。所以写一整行。
  const { ReadStream } = await import('node:tty');
  const slave = new ReadStream(p.slave);
  slave.setEncoding('utf8');
  t.after(() => { try { slave.destroy(); } catch { /* 已经没了。 */ } });
  const arrived = new Promise<string>(resolve => slave.once('data', chunk => resolve(String(chunk))));
  adopted.write('typed\n');
  assert.match(await arrived, /typed/);
});

/*
  这一条是整件事的关键。

  接管之后已经没有 `IPty` 对象了，而 node-pty 的 resize 是原生的——但它把入口暴露在
  `.native` 上，直接对裸 fd 调是生效的。**所以不需要 fork node-pty。**
  这里从 slave 端读回 winsize 来证明 ioctl 真的落下去了。
*/
test('resize 对裸 fd 生效，slave 端能看到新的 winsize', async (t) => {
  const p = pair(80, 24);
  const adopted = adoptPty({ fd: p.master, pid: process.pid, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => { adopted.kill('SIGCONT'); p.closeSlave(); });
  const slave = new (await import('node:tty')).WriteStream(p.slave);
  assert.deepEqual([slave.columns, slave.rows], [80, 24], '前提没摆对');
  adopted.resize(120, 40);
  assert.deepEqual([adopted.cols, adopted.rows], [120, 40]);
  // WriteStream 缓存了尺寸，重新问一次内核。
  const again = new (await import('node:tty')).WriteStream(p.slave);
  assert.deepEqual([again.columns, again.rows], [120, 40], 'ioctl 没有真的落到 fd 上');
});

test('尺寸不合法就不动，也不报错', async (t) => {
  const p = pair();
  const adopted = adoptPty({ fd: p.master, pid: process.pid, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => { adopted.kill('SIGCONT'); p.closeSlave(); });
  for (const [cols, rows] of [[0, 24], [80, 0], [-1, -1], [1.5, 24]]) adopted.resize(cols, rows);
  assert.deepEqual([adopted.cols, adopted.rows], [80, 24]);
});

/*
  接管过来的这条路上拿不到退出码：那次 spawn 属于上一个映像，waitpid 的结果被它带走了。
  能观察到的只有「master 端读到头了」。所以退出码一律 0——编不出来的数字不要编。
*/
test('slave 全部关掉时报一次 exit，之后写入不再抛', async (t) => {
  const p = pair();
  const adopted = adoptPty({ fd: p.master, pid: process.pid, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => p.closeSlave());
  let exits = 0;
  adopted.onExit(() => exits++);
  p.closeSlave();
  for (let i = 0; i < 40 && exits === 0; i++) await tick(25);
  assert.equal(exits, 1, 'slave 关掉之后应该收到一次 exit');
  adopted.write('写给已经没有的对面');
  adopted.resize(100, 30);
  await tick();
  assert.equal(exits, 1, 'exit 只报一次');
});

test('携带过来的 ptsName 和 pid 原样保留——服务归属靠它', async (t) => {
  const p = pair();
  const adopted = adoptPty({ fd: p.master, pid: 4242, cols: 80, rows: 24, ptsName: p.pty }, native);
  t.after(() => { p.closeSlave(); });
  assert.equal(adopted.pid, 4242);
  assert.equal(adopted.ptsName, p.pty);
  assert.match(String(adopted.ptsName), /^\/dev\/tty/);
});
