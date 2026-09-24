import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTty, parseListeners, terminalServices, listeningServices } from '../src/terminal-services.ts';

const proc = (pid: number, ppid: number, tty: string, args: string) => ({ pid, ppid, tty, args });

test('归属靠 tty，不靠父子关系', () => {
  // 这是实测出来的关键：AI 起 `npm run dev &` 之后那次调用返回，服务被过继到 PID 1。
  // 祖先链断了，但 tty 还在。
  const rows = [
    proc(100, 1, 'ttys002', '/bin/zsh -l'),
    proc(500, 1, 'ttys002', 'node vite --port 5173'),   // ← ppid 已经是 1
    proc(600, 1, 'ttys009', 'node 别的终端的服务'),
  ];
  const out = terminalServices({ tty: '/dev/ttys002', rows, listeners: [{ pid: 500, address: '*:5173' }] });
  assert.deepEqual(out.map(s => s.pid), [500, 100], '被过继的服务照样归属得到');
  assert.deepEqual(out[0]!.listening, ['*:5173']);
  assert.equal(out.find(s => s.pid === 600), undefined, '别的终端的不混进来');
});

test('有端口的排前面', () => {
  const rows = [proc(10, 1, 'ttys002', 'a'), proc(20, 1, 'ttys002', 'b'), proc(30, 1, 'ttys002', 'c')];
  const out = terminalServices({ tty: 'ttys002', rows, listeners: [{ pid: 30, address: '127.0.0.1:8080' }] });
  assert.deepEqual(out.map(s => s.pid), [30, 10, 20]);
});

test('一个进程监听多个地址时全都列出来，不互相覆盖', () => {
  const rows = [proc(10, 1, 'ttys002', 'server')];
  const out = terminalServices({ tty: 'ttys002', rows,
    listeners: [{ pid: 10, address: '*:5173' }, { pid: 10, address: '[::1]:5173' }, { pid: 10, address: '*:5173' }] });
  assert.deepEqual(out[0]!.listening, ['*:5173', '[::1]:5173'], '去重并排序');
});

test('没有控制终端的进程不算这个终端的', () => {
  // setsid / 标准 daemon 化之后 tty 变 `??`。认不出就是认不出，不猜。
  const rows = [proc(10, 1, 'ttys002', 'shell'), proc(20, 1, '??', 'daemon 化的服务')];
  const out = terminalServices({ tty: 'ttys002', rows, listeners: [{ pid: 20, address: '*:9999' }] });
  assert.deepEqual(out.map(s => s.pid), [10]);
});

test('拿不到 tty 时返回空 —— Windows 那条路要靠这个', () => {
  const rows = [proc(10, 1, 'ttys002', 'shell')];
  for (const tty of [null, undefined, '', '??']) {
    assert.deepEqual(terminalServices({ tty, rows, listeners: [] }), [], String(tty));
  }
});

test('shell 和 CLI 自己不算服务', () => {
  const rows = [proc(100, 1, 'ttys002', '/bin/zsh -l'), proc(200, 100, 'ttys002', 'claude'),
    proc(300, 200, 'ttys002', 'node server.js')];
  const out = terminalServices({ tty: 'ttys002', rows, listeners: [], excludePids: [100, 200] });
  assert.deepEqual(out.map(s => s.pid), [300]);
});

test('normalizeTty 吃两种写法', () => {
  assert.equal(normalizeTty('/dev/ttys017'), 'ttys017', 'node-pty 的 ptsName');
  assert.equal(normalizeTty('ttys017'), 'ttys017', 'ps 的写法');
  assert.equal(normalizeTty('??'), null);
  assert.equal(normalizeTty(undefined), null);
});

test('lsof 输出解析：跳过表头和短行', () => {
  const out = parseListeners([
    'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    'node    15988 me     23u  IPv4 0xabc      0t0  TCP *:5199 (LISTEN)',
    '坏行',
    'caddy   16024 me      3u  IPv6 0xdef      0t0  TCP *:8080 (LISTEN)',
  ].join('\n'));
  assert.deepEqual(out, [{ pid: 15988, address: '*:5199' }, { pid: 16024, address: '*:8080' }]);
});

/*
  整机视角：哪个端口上跑着什么。

  和上面那个「这条终端起了什么」不同，这里**不按 tty 过滤**——人想知道「8080 是谁占着」
  的时候，往往正因为那东西不是从当前终端起的。
*/
test('按端口列出在监听的进程，端口升序', () => {
  const rows = [
    { pid: 10, ppid: 1, args: 'node server.js' },
    { pid: 20, ppid: 1, args: 'caddy run' },
  ] as never;
  const services = listeningServices({ rows, listeners: [
    { pid: 10, address: '127.0.0.1:8787' },
    { pid: 20, address: '*:8080' },
  ] });
  assert.deepEqual(services.map(s => [s.port, s.pid, s.command]),
    [[8080, 20, 'caddy run'], [8787, 10, 'node server.js']], '端口升序，不是按发现顺序');
});

test('一个进程监听多个端口就出现多行——它们是各自独立的答案', () => {
  const rows = [{ pid: 10, ppid: 1, args: 'node app.js' }] as never;
  const services = listeningServices({ rows, listeners: [
    { pid: 10, address: '*:3000' }, { pid: 10, address: '*:3001' },
  ] });
  assert.deepEqual(services.map(s => s.port), [3000, 3001]);
});

test('同一个 pid 同一个地址被报多行时去重', () => {
  // lsof 会为 IPv4/IPv6 各报一条，同一个地址重复出现。
  const rows = [{ pid: 10, ppid: 1, args: 'node app.js' }] as never;
  const services = listeningServices({ rows, listeners: [
    { pid: 10, address: '*:3000' }, { pid: 10, address: '*:3000' },
  ] });
  assert.equal(services.length, 1);
});

test('解析不出端口就给 null，不猜；这种排在最后', () => {
  /*
    **宁可少一列，不要给个错数字。** 界面上「8080」和「不知道」是两种完全不同的信息，
    而一个猜出来的端口号会让人去 kill 错东西。
  */
  const rows = [{ pid: 10, ppid: 1, args: 'weird' }, { pid: 11, ppid: 1, args: 'node' }] as never;
  const services = listeningServices({ rows, listeners: [
    { pid: 10, address: 'some-unix-thing' }, { pid: 11, address: '*:9000' },
  ] });
  assert.deepEqual(services.map(s => s.port), [9000, null], '解析不出的排最后，不插在中间打断扫视');

  /*
    **越界的数字也算解析不出。** 只拿「压根没有冒号数字」当反例是不够的——那种在更早一步
    就返回了，范围判断这一段根本没跑（变异测试发现：把越界时的 null 改成 0，用例照样绿）。
  */
  for (const address of ['*:99999', '*:0']) {
    const [only] = listeningServices({ rows: [], listeners: [{ pid: 1, address }] });
    assert.equal(only!.port, null, `${address} 不是一个端口号`);
  }
});

test('ps 里已经没有这个进程时，命令行是 null 而不是空字符串', () => {
  // lsof 看得见、ps 里已经退出——这是「不知道它是什么」，不是「它没有名字」。
  const services = listeningServices({ rows: [], listeners: [{ pid: 99, address: '*:1234' }] });
  assert.equal(services[0]!.command, null);
});
