import test from 'node:test';
import assert from 'node:assert/strict';
import { appName, primaryPort, launchApps, appUrl } from '../src/features/launchpad/apps.ts';
import type { ListeningService } from '../src/shared/api/serverMonitor.ts';

const service = (over: Partial<ListeningService>): ListeningService => ({
  address: `*:${over.port ?? 3000}`, port: 3000, pid: 1, command: null, ppid: null, parent: null,
  tty: null, terminalId: null, addresses: [], label: null, scope: 'public', http: null, ...over,
});

test('应用名取命令行的第一个词', () => {
  // 卡片是用来「认」的,不是用来读的;参数留在 detail 里。
  assert.equal(appName('vite --port 5199 --strictPort', 5199), 'vite');
  assert.equal(appName('postgres -D data -p 5433', 5433), 'postgres');
});

test('第一个词是解释器时往后找——否则一屏卡片两两同名', () => {
  /*
    实测本机 11 张卡里有两张叫 `python`、两张叫 `node`,这个列表就白排了。
    解释器名不区分任何东西。
  */
  assert.equal(appName('python -m retainpdf_ai', 41100), 'retainpdf_ai', '-m 后面就是模块名');
  assert.equal(appName('python -m hermes_cli.main serve --host 127.0.0.1', 55146), 'hermes_cli.main');
  assert.equal(appName('node --import tsx backend/src/index.ts', 8787), 'index.ts', '取最后一个像脚本的段');
});

test('有多个像脚本的段时取最后一个', () => {
  // `--require ./setup.js server.js` 里真正被跑的是 server.js,前面那个只是预加载。
  assert.equal(appName('node --require ./setup.js server.js', 3000), 'server.js');
});

test('-m 后面没有东西或是个选项时不拿来当名字', () => {
  // 命令行被截断,或者写成 `-m --help`。拿 `--help` 当卡片标题比同名更糟。
  assert.equal(appName('python -m', 9000), 'python');
  assert.equal(appName('python -m --help', 9000), 'python');
});

test('后面没有脚本时退回解释器名,不把一段代码当标题', () => {
  /*
    `node -e require("http").createServer()` 硬往后取会取到一串代码。
    **宁可两张卡同名,也不要把代码当标题**——同名还能靠端口和 detail 分辨,
    一串代码会把整行撑爆。
  */
  assert.equal(appName('node -e require("http").createServer()', 45999), 'node');
  assert.equal(appName('python', 9000), 'python');
});

test('第一个词不是解释器时原样用它', () => {
  assert.equal(appName('caddy run --config Caddyfile', 8080), 'caddy');
  assert.equal(appName('rust_api', 41000), 'rust_api');
});

test('没有命令行时用端口号,不画一张没名字的卡片', () => {
  // 进程已退出但端口还在 lsof 里时会走到这里。
  for (const label of [null, '', '   ']) assert.equal(appName(label, 8080), ':8080');
});

test('一个进程多个端口时挑最小的那个', () => {
  /*
    不是随便定的:小的那个几乎总是主服务,大的是调试端口、metrics 或随机辅助端口
    (本机 retain-pdf 那个进程就是 41000 主服务 + 42000 辅助)。挑错了点开是一张 404。
  */
  assert.equal(primaryPort([42000, 41000]), 41000);
  assert.equal(primaryPort([3000]), 3000);
});

test('http 为 false 的挡掉——启动台不该把 postgres 画成应用', () => {
  const apps = launchApps([
    service({ port: 5173, pid: 1, label: 'vite', http: true }),
    service({ port: 5433, pid: 2, label: 'postgres', http: false }),
  ], () => undefined);
  assert.deepEqual(apps.map(app => app.port), [5173]);
});

test('http 为 null 的放行——null 是「没探测」,不是「不是 HTTP」', () => {
  /*
    **把 null 当成 false 会让整个启动台变空**,而且是静默的:接口没带 probe=1 时
    每一项都是 null。两格的区别就是为此存在的。
  */
  const apps = launchApps([service({ port: 5173, pid: 1, label: 'vite', http: null })], () => undefined);
  assert.equal(apps.length, 1);
});

test('没有端口号的挡掉', () => {
  // unix socket 那类。列出来也点不开。
  assert.deepEqual(launchApps([service({ port: null, pid: 1, http: true })], () => undefined), []);
});

test('同一个进程的多个端口并成一项,其余进 alsoOn', () => {
  const apps = launchApps([
    service({ port: 42000, pid: 7, label: 'rust_api', http: true }),
    service({ port: 41000, pid: 7, label: 'rust_api', http: true }),
  ], () => undefined);
  assert.equal(apps.length, 1, '同一个进程只出一张卡');
  assert.equal(apps[0]!.port, 41000);
  assert.deepEqual(apps[0]!.alsoOn, [42000]);
});

test('detail 优先显示会话标题,而不是再看一遍命令行', () => {
  // 「这东西是我在哪儿起的」比命令行有用得多。
  const apps = launchApps([service({ port: 5173, pid: 1, label: 'vite', terminalId: 's_abc', http: true })],
    id => id === 's_abc' ? 'roost-前端' : undefined);
  assert.equal(apps[0]!.detail, 'roost-前端');
});

test('会话查不到标题时退回会话 id,不退回命令行', () => {
  /*
    查不到说明那条会话已经关了,而 id 正是这时候唯一能用的线索——这正是「关了之后
    找不回 id」要解决的事。退回命令行就把这条线索丢了。
  */
  const apps = launchApps([service({ port: 5173, pid: 1, label: 'vite', terminalId: 's_gone', http: true })],
    () => undefined);
  assert.equal(apps[0]!.detail, 's_gone');
});

test('完全认不出会话时才用命令行', () => {
  const apps = launchApps([service({ port: 8080, pid: 1, label: 'caddy run', http: true })], () => undefined);
  assert.equal(apps[0]!.detail, 'caddy run');
});

test('认得出会话的排前面,其余按端口号', () => {
  /*
    人在启动台上找的几乎总是自己刚起的那个;把它们压在 Chrome 的调试端口下面,
    等于每次都要扫一遍才找得到。
  */
  const apps = launchApps([
    service({ port: 9222, pid: 1, label: 'chrome', http: true }),
    service({ port: 5173, pid: 2, label: 'vite', terminalId: 's_a', http: true }),
    service({ port: 3000, pid: 3, label: 'other', http: true }),
  ], () => 'X');
  assert.deepEqual(apps.map(app => app.port), [5173, 3000, 9222]);
});

test('地址就是反代认的那个前缀', () => {
  assert.equal(appUrl(5173), '/api/app/5173/');
});

/* 固定与排序。 */
import { arrangeApps, reorderPins, togglePin, isOffline } from '../src/features/launchpad/apps.ts';

test('固定区按用户拖出来的顺序,不按自动排序', () => {
  /*
    这是 arrangeApps 存在的全部理由。自动排序(认得出会话的在前、然后按端口)对固定区
    是错的——用户已经拖过了。
  */
  const apps = [
    service({ port: 3000, pid: 1, label: 'a', http: true }),
    service({ port: 5173, pid: 2, label: 'b', terminalId: 's_x', http: true }),
  ];
  const { pinned } = arrangeApps(launchApps(apps, () => 'X'), [3000, 5173]);
  assert.deepEqual(pinned.map(app => app.port), [3000, 5173], '3000 在前,尽管 5173 认得出会话');
});

test('固定了但没在跑的照样占位置,不消失', () => {
  /*
    固定的意思是「我常用这个」。dev server 一停它就从列表里没了、重启之后又跑到别处,
    固定这件事就白做了——保住那个位置才是它的价值。
  */
  const { pinned, rest } = arrangeApps(
    launchApps([service({ port: 3000, pid: 1, label: 'a', http: true })], () => undefined),
    [5173, 3000]);
  assert.equal(pinned.length, 2);
  assert.ok(isOffline(pinned[0]!) && pinned[0]!.port === 5173);
  assert.ok(!isOffline(pinned[1]!));
  assert.deepEqual(rest, [], '已固定的不再出现在其余里');
});

test('没固定的走自动排序', () => {
  const apps = launchApps([
    service({ port: 9222, pid: 1, label: 'chrome', http: true }),
    service({ port: 5173, pid: 2, label: 'vite', terminalId: 's_x', http: true }),
  ], () => 'X');
  const { rest } = arrangeApps(apps, []);
  assert.deepEqual(rest.map(app => app.port), [5173, 9222]);
});

test('拖到自己身上不改顺序', () => {
  assert.deepEqual(reorderPins([1, 2, 3], 2, 2), [1, 2, 3]);
});

test('拖到一个已经不在表里的位置时原样返回,不丢项', () => {
  // 拖动过程中那个应用退出、固定项被别处改掉,都会走到这里。返回少一项的表是静默的数据丢失。
  assert.deepEqual(reorderPins([1, 2, 3], 2, 99), [1, 2, 3]);
  assert.deepEqual(reorderPins([1, 2, 3], 99, 2), [1, 2, 3]);
});

test('往前拖和往后拖都落在目标位置上', () => {
  assert.deepEqual(reorderPins([1, 2, 3], 3, 1), [3, 1, 2]);
  assert.deepEqual(reorderPins([1, 2, 3], 1, 3), [2, 3, 1]);
});

test('新固定的排在最后,不插在最前', () => {
  // 插在最前会把用户自己排好的顺序推乱。
  assert.deepEqual(togglePin([1, 2], 3), [1, 2, 3]);
  assert.deepEqual(togglePin([1, 2, 3], 2), [1, 3]);
});
