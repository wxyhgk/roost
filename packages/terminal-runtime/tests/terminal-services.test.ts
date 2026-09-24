import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTty, parseListeners, terminalServices, listeningServices, shortCommand, listenScope } from '../src/terminal-services.ts';

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
  // 详情里那份「全部地址」也要去重——它是另一段代码，行级去重管不到它（变异测试发现）。
  assert.deepEqual(services[0]!.addresses, ['*:3000']);
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

/*
  详情要回答的三个问题：这东西是谁拉起来的、从哪条终端起的、它一共占了哪些端口。
*/
test('带出父进程、tty 和该进程的全部监听地址', () => {
  const rows = [
    { pid: 1, ppid: 0, args: '/sbin/launchd', tty: '??' },
    { pid: 10, ppid: 1, args: 'node server.js', tty: 'ttys002' },
  ] as never;
  const [first, second] = listeningServices({ rows, listeners: [
    { pid: 10, address: '*:3000' }, { pid: 10, address: '127.0.0.1:3001' },
  ] });
  assert.equal(first!.ppid, 1);
  assert.equal(first!.parent, '/sbin/launchd', '回答「是谁拉起来的」');
  assert.equal(first!.tty, 'ttys002', '进程被过继给 launchd 之后 tty 仍然保留，这是归属回终端的唯一判据');
  assert.deepEqual(first!.addresses, ['*:3000', '127.0.0.1:3001'], '详情要一次看全它占的所有端口');
  assert.deepEqual(second!.addresses, first!.addresses, '同一个进程的两行看到的是同一份');
});

test('没有控制终端时 tty 是 null，不是 "??"', () => {
  // ps 对没有控制终端的进程报 `??`。把那个字符串原样透出去，界面上会显示成一个假终端名。
  const rows = [{ pid: 10, ppid: 1, args: 'daemon', tty: '??' }] as never;
  assert.equal(listeningServices({ rows, listeners: [{ pid: 10, address: '*:80' }] })[0]!.tty, null);
});

test('父进程在 ps 里已经没了时给 null，不给空串', () => {
  const rows = [{ pid: 10, ppid: 999, args: 'orphan', tty: 'ttys003' }] as never;
  const [only] = listeningServices({ rows, listeners: [{ pid: 10, address: '*:80' }] });
  assert.equal(only!.ppid, 999, 'ppid 本身是知道的');
  assert.equal(only!.parent, null, '但那个进程是什么，我们不知道——不知道就说不知道');
});

/*
  归属：这个端口是从 roost 的哪条会话起的。

  这几条在意的不是「能不能认出来」，而是**两个判据的优先级**。上线的第一版只比 tty，
  在真机上一个都认不出（19 个监听端点里 0 个还有控制终端），所以顺序不是风格问题。
*/
test('环境变量优先于 tty，不是反过来', () => {
  const rows = [{ pid: 10, ppid: 1, args: 'node app.js', tty: 'ttys002' }] as never;
  const [only] = listeningServices({
    rows, listeners: [{ pid: 10, address: '*:3000' }],
    envOwners: new Map([[10, 's_env']]),
    ttyOwners: new Map([['ttys002', 's_tty']]),
  });
  assert.equal(only!.terminalId, 's_env', '两个判据都命中时取环境变量那个');
  assert.equal(only!.tty, 'ttys002', 'tty 本身照常透出——它回答的是另一个问题');
});

test('环境变量认不出时退回 tty', () => {
  const rows = [{ pid: 10, ppid: 1, args: 'node app.js', tty: 'ttys002' }] as never;
  const [only] = listeningServices({
    rows, listeners: [{ pid: 10, address: '*:3000' }],
    envOwners: new Map([[99, 's_other']]),
    ttyOwners: new Map([['ttys002', 's_tty']]),
  });
  assert.equal(only!.terminalId, 's_tty');
});

test('两个判据都认不出就是 null——不猜', () => {
  /*
    开机自启的服务本来就不属于任何终端。硬塞一个会把人引到错的地方去找，
    而「—」是个诚实且有用的答案（本机的 8080/8787 正是这一格）。
  */
  const rows = [{ pid: 10, ppid: 1, args: 'caddy run', tty: '??' }] as never;
  const [only] = listeningServices({
    rows, listeners: [{ pid: 10, address: '*:8080' }],
    envOwners: new Map(), ttyOwners: new Map([['ttys002', 's_tty']]),
  });
  assert.equal(only!.terminalId, null);
  assert.equal(only!.tty, null, '`??` 不是一个 tty');
});

test('一个判据都不给时也不炸，terminalId 为 null', () => {
  // 调用方可以只要「谁占着这个端口」而不关心归属（两个可选参数都不传）。
  const rows = [{ pid: 10, ppid: 1, args: 'node app.js', tty: 'ttys002' }] as never;
  const [only] = listeningServices({ rows, listeners: [{ pid: 10, address: '*:3000' }] });
  assert.equal(only!.terminalId, null);
});

/*
  列表那一行显示的短命令名。

  这不是装饰：截到一列宽之后，能认出这东西的那个词必须还在。
*/
test('丢掉可执行文件的路径，留下能认出它的那个词', () => {
  assert.equal(shortCommand('node /Users/me/Code/roost/node_modules/.bin/vite'), 'vite',
    '解释器名不区分任何东西（本机 19 个端点里 5 个都是 node），路径是噪声');
  assert.equal(shortCommand('/opt/homebrew/bin/postgres -D data -p 5433'), 'postgres -D data -p 5433',
    '参数要留着——同一个程序的两个实例往往只靠参数分得开');
});

test('可执行文件路径里有空格也要收对', () => {
  /*
    **这是第一版真正错掉的那一格。** 按空格切开再逐段取 basename，
    `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 会变成
    `Google Chrome.app/Contents/MacOS/Goo…`——比不处理还糟。
  */
  assert.equal(
    shortCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9357'),
    'Google Chrome --headless=new --remote-debugging-port=9357');
});

test('解释器后面紧跟选项时不能把解释器丢掉', () => {
  // `node -e …` 丢了 node 就只剩一串 `-e`，什么都认不出。
  assert.equal(shortCommand('node -e require("http").createServer()'), 'node -e require("http").createServer()');
  assert.equal(shortCommand('python -m retainpdf_ai'), 'python -m retainpdf_ai');
  // 大小写也算：macOS 自带的那个叫 `Python`（本机实测 serve_static.py 那一行）。
  assert.equal(shortCommand('/Library/Developer/CommandLineTools/usr/bin/Python serve_static.py --host 0.0.0.0'),
    'serve_static.py --host 0.0.0.0');
});

test('参数里独立成段的绝对路径收短，但 --flag=/a/b 不动', () => {
  assert.equal(shortCommand('caddy run --config /etc/caddy/Caddyfile'), 'caddy run --config Caddyfile');
  assert.equal(shortCommand('app --socket=/tmp/x/app.sock'), 'app --socket=/tmp/x/app.sock',
    '等号后面的路径往往就是这个参数的意思所在，收短了会认错');
});

test('没有命令行时给 null，不给空串', () => {
  // 空串会在界面上画成一个空格子，而「进程已退出」是调用方要自己决定怎么说的话。
  for (const value of [null, undefined, '', '   ']) assert.equal(shortCommand(value), null);
});

/*
  监听地址的范围。

  这一格替掉了面板上那一整列地址——原来 `5173` 旁边并排放着 `*:5173`，重复的部分占了
  窄面板三分之一宽度，把命令名挤成 `postg…`。冒号前面那一截才是唯一不重复的信息。
*/
test('通配地址算「公开」', () => {
  for (const address of ['*:5173', '0.0.0.0:8080', '[::]:3000', '::' + ':9000'])
    assert.equal(listenScope(address), 'public', address);
});

test('回环算「仅本机」——127.0.0.0/8 整段都是', () => {
  for (const address of ['127.0.0.1:8787', '[::1]:9371', '127.1.2.3:5000'])
    assert.equal(listenScope(address), 'local', address);
});

test('绑在具体网卡上不能算成「仅本机」', () => {
  /*
    **这是这里唯一会造成实际损害的错法**：把一个对局域网或 tailscale 开着的端口说成
    只有自己连得上。这台机器从公网访问，这一格不是学术问题。
  */
  for (const address of ['203.0.113.4:60030', '198.51.100.7:60032', '[fd00::1]:60031'])
    assert.equal(listenScope(address), 'interface', address);
});

test('认不出形状的地址不作任何承诺', () => {
  /*
    三格里只有 `interface` 不承诺范围。说一句「仅本机」才是这里唯一会造成实际损害的输出，
    所以拿不准时落在这一格——unix socket 那种没有冒号的行走的就是这条（变异测试发现
    原来的 `host === ''` 分支根本到不了：lsof 永远给 `host:port`）。
  */
  assert.equal(listenScope('some-unix-thing'), 'interface');
});

test('端口号本身不参与判断', () => {
  // 地址里可以有多个冒号（IPv6），所以取的是**最后一个**冒号前面那一截。
  assert.equal(listenScope('[::1]:127'), 'local', '端口恰好长得像回环地址也不算数');
  assert.equal(listenScope('*:1'), 'public');
});
