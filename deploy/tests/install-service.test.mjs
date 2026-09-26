import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { backendScript, caddyfile, plan, servicePlist } from '../../scripts/install-service.mjs';

const run = promisify(execFile);

const options = {
  node: '/opt/node/bin/node',
  repo: '/src/roost',
  dataDir: '/data/roost',
  installDir: '/share/roost',
  port: 8080,
  backendPort: 8787,
  origins: ['http://127.0.0.1:8080', 'http://localhost:8080'],
  insecureHttp: true,
  shell: '/bin/zsh',
  caddy: '/opt/bin/caddy',
  pathEntries: '/usr/bin:/bin',
};

/*
  launchd 对坏 plist 的报错很难读懂，所以生成的东西必须先能通过 plutil。

  **而 plutil 只有 macOS 有。** 这几条因此在别的系统上明确跳过——它们校验的是
  launchd 的 plist，本来就只在 macOS 上有意义；在 Linux 上红只说明那台机器没有
  这个工具，不说明生成器坏了。其余几条（Caddyfile、后端脚本、PATH 过滤）与平台
  无关，照跑不误。
*/
const macOnly = process.platform === 'darwin' ? undefined : { skip: 'plutil 只有 macOS 有' };
/** launchd 对坏 plist 的报错很难读懂，所以生成的东西必须先能通过 plutil。 */
async function parse(text) {
  const dir = await mkdtemp(join(tmpdir(), 'roost-plist-'));
  try {
    const path = join(dir, 'x.plist');
    await writeFile(path, text);
    await run('plutil', ['-lint', path]);
    return JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', path])).stdout);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('每个 plist 都是合法的，并带齐 launchd 需要的键', macOnly, async () => {
  for (const service of plan(options).services) {
    const parsed = await parse(service.plist);
    assert.equal(parsed.Label, service.label);
    assert.deepEqual(parsed.ProgramArguments, service.args);
    // 相对路径的 ProgramArguments（deploy/…）只有靠它才解析得到。
    assert.equal(parsed.WorkingDirectory, options.repo);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.KeepAlive, true);
    // 起不来的服务会被 launchd 全速重试，日志刷屏。
    assert.ok(parsed.ThrottleInterval >= 10);
    // 终端守护进程要把历史落盘再退出；默认 5 秒不够，超时就是 SIGKILL 丢输出。
    assert.ok(parsed.ExitTimeOut >= 20);
    assert.equal(parsed.Umask, 0o077);
    assert.equal(parsed.StandardOutPath, parsed.StandardErrorPath);
    assert.ok(parsed.StandardOutPath.startsWith(join(options.dataDir, 'logs')));
  }
});

test('环境变量把数据目录、端口和来源传下去，node 排在 PATH 最前', macOnly, async () => {
  const { EnvironmentVariables: env } = await parse(plan(options).services[0].plist);
  assert.equal(env.ROOST_DATA_DIR, options.dataDir);
  assert.equal(env.PORT, '8787');
  // 来源名单已经删掉：判定改成了「Origin 等于请求自己的 Host」，plist 里不该再有这个。
  assert.equal('ROOST_ALLOWED_ORIGINS' in env, false);
  assert.equal(env.SHELL, '/bin/zsh');
  // 服务里跑的 node 必须是安装时那一个，不能撞上 PATH 上别的版本。
  assert.deepEqual(env.PATH.split(':'), ['/opt/node/bin', '/usr/bin', '/bin']);
});

test('--secure-cookies 时不注入放行明文 HTTP 的变量', macOnly, async () => {
  const on = await parse(plan(options).services[0].plist);
  assert.equal(on.EnvironmentVariables.ROOST_AUTH_INSECURE_HTTP, '1');
  const off = await parse(plan({ ...options, insecureHttp: false }).services[0].plist);
  assert.equal('ROOST_AUTH_INSECURE_HTTP' in off.EnvironmentVariables, false);
});

/*
  「从网页把消息写进终端」这条通道。

  它让守护进程可以往一条活着的 PTY 里粘贴文本并补回车——也就是**能替用户打字**。写入本身
  有层层门禁（输入框空、画面稳、权限弹窗不写、绝不自动批准），但那些是写入**时**的判据；
  「有没有这个能力」是另一回事，所以必须是显式开关，而且默认关。

  这里钉两件：默认关，以及**只给 terminal 一个服务**。后端和 Caddy 拿到它没有任何用处，
  而一个这种分量的开关出现在不需要它的进程里，以后查「谁有这个能力」会多出假线索。
*/
test('--gui-send 默认关，而且只给 terminal 服务', macOnly, async () => {
  const off = plan(options).services;
  for (const service of off) {
    const { EnvironmentVariables: env } = await parse(service.plist);
    assert.equal('ROOST_CLAUDE_GUI_SEND' in env, false, `${service.name} 默认不该有这个能力`);
  }

  const on = plan({ ...options, guiSend: true }).services;
  const holders = [];
  for (const service of on) {
    const { EnvironmentVariables: env } = await parse(service.plist);
    if (env.ROOST_CLAUDE_GUI_SEND === '1') holders.push(service.name);
  }
  assert.deepEqual(holders, ['terminal'], '只有守护进程会往 PTY 写字节，别的服务不该拿到这个开关');
});

/*
  **「默认关」这条性质住在命令行解析里，不在 `plan()` 里**，所以必须真的把脚本跑起来才测得到。

  上面那两条用例直接调 `plan()`，绕过了参数解析——变异测试当场戳穿：把
  `flags.has('gui-send')` 改成 `true`，它们照样全绿。而这正是最不能错的一条：这个开关
  给的是「替用户往终端里打字」的能力，默认必须是关的。
*/
test('默认不开这个能力——真跑一遍脚本，不绕过参数解析', () => {
  const script = fileURLToPath(new URL('../../scripts/install-service.mjs', import.meta.url));
  /*
    **显式指出 caddy 在哪，别让这条用例去环境里找。**

    脚本启动时会先定位 caddy（`findCaddy`），找不到就退出 1——而 CI 的 ubuntu runner 上
    没装。于是这条用例在 GitHub Actions 上**每一次都红**，报的是「找不到 caddy」，
    和它要测的「那个开关默认关着」毫无关系。

    路径不必真的存在：`--caddy` 给了值就直接采用，`--dry-run` 只把将要写的内容打印出来，
    这个字符串最后只是 plist 里的一行文本。这条用例测的是参数解析，不是环境。
  */
  const run = (...args) => spawnSync(process.execPath, [script, '--dry-run', '--caddy', '/usr/bin/caddy', ...args], { encoding: 'utf8' });

  const off = run();
  assert.equal(off.status, 0, off.stderr);
  assert.equal(off.stdout.includes('ROOST_CLAUDE_GUI_SEND'), false, '不给参数时绝不能出现这个变量');

  const on = run('--gui-send');
  assert.equal(on.status, 0, on.stderr);
  // 三个服务的 plist 都在输出里，只该命中一次。
  assert.equal((on.stdout.match(/ROOST_CLAUDE_GUI_SEND/g) ?? []).length, 1, '只有 terminal 服务该拿到它');
});

test('打开 gui-send 不影响其余环境变量', macOnly, async () => {
  const before = (await parse(plan(options).services[0].plist)).EnvironmentVariables;
  const after = (await parse(plan({ ...options, guiSend: true }).services[0].plist)).EnvironmentVariables;
  // 新增一个键，其余逐字不变——开关不该顺手改别的东西。
  assert.deepEqual(Object.keys(after).filter(k => k !== 'ROOST_CLAUDE_GUI_SEND').sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) assert.equal(after[key], before[key], key);
});

test('plist 里的值转义 XML，含 & 和 < 的路径不会把文件写坏', macOnly, async () => {
  const parsed = await parse(servicePlist({
    label: 'com.roost.test', args: ['/bin/echo', 'a&b'], workingDirectory: '/a<b>c',
    env: { X: 'y&z' }, logPath: '/tmp/a&b.log',
  }));
  assert.deepEqual(parsed.ProgramArguments, ['/bin/echo', 'a&b']);
  assert.equal(parsed.WorkingDirectory, '/a<b>c');
  assert.equal(parsed.EnvironmentVariables.X, 'y&z');
});

test('Caddy 两个 root 都指向发布后的位置，不指仓库里的构建产物', () => {
  const text = caddyfile({ port: 8080, backendPort: 8787, assetsDir: '/share/roost/assets', webDir: '/share/roost/web' });
  assert.match(text, /http:\/\/:8080 \{/);
  assert.match(text, /reverse_proxy 127\.0\.0\.1:8787/);
  // 哈希资产只增不删，不能指向 dist/assets——一次发布就会让已打开的页面加载不到旧块。
  assert.match(text, /handle_path \/assets\/\*[\s\S]*?root \* "\/share\/roost\/assets"/);
  /*
    外壳同理，而且理由更硬：兜底 root 一旦指回 frontend/dist，npm run build 就**直接写进了
    线上**——它先把 index.html 换成指向新哈希的版本，而那些哈希要等发布才到位，中间入口
    脚本 404、页面纯白。两天内栽了三次，所以这条钉死。
  */
  assert.match(text, /root \* "\/share\/roost\/web"/);
  // 只盯 root 指令本身：注释里提到 dist 是在说明「为什么不能指回去」，那是该留的。
  for (const [, dir] of text.matchAll(/^\s*root \* "([^"]+)"/gm))
    assert.doesNotMatch(dir, /frontend\/dist/, '构建产物目录不许被 Caddy 直接服务');
  assert.match(text, /try_files \{path\} \/index\.html/);
});

test('带应用 Referer 的请求要转给后端，而且排在 SPA 兜底之前', () => {
  /*
    浮动窗口里的应用引的是 `/@vite/client`、`/assets/x.js` 这种从根算起的地址。
    **caddy 默认只转 `/api/*`**，所以少了这条匹配，这些请求根本到不了后端的代理，
    而是被 `try_files … /index.html` 当成前端路由，回一份 roost 自己的 index.html——
    iframe 里于是拿到 HTML 而不是脚本，只报一句 MIME 不对。

    顺序也要测：caddy 的 handle 块按定义先后互斥匹配，排在 /assets/* 和兜底之后就等于
    没写——而这一点在生成的文本里看不出来，只有位置能说明。
  */
  const text = caddyfile({ port: 8080, backendPort: 8787, assetsDir: '/share/roost/assets', webDir: '/share/roost/web' });
  // 用字面量比，不用正则：这一行本身就是个正则，再套一层转义只会把测试写错（第一版就是）。
  assert.ok(text.includes('@appReferer header_regexp Referer ^https?://[^/]+/api/app/[0-9]{1,5}/'),
    '匹配器要认出 /api/app/<端口>/ 形态的 Referer');
  const referer = text.indexOf('@appReferer');
  assert.ok(referer > 0 && referer < text.indexOf('handle_path /assets/*'), '必须排在 /assets/* 之前');
  /*
    找的是**指令本身**，不是 `try_files` 这个词：上面那段注释里就提到了它，
    按词去找会命中注释，而注释排在前面，于是这条断言恒假。同一个坑这个月踩过三次
    （`return null;\n}`、`transcript_unavailable`、这一次），锚点必须唯一。
  */
  assert.ok(referer < text.indexOf('try_files {path} /index.html'), '必须排在 SPA 兜底之前');
});

test('后端脚本先等终端 owner 就绪再启动', () => {
  const text = backendScript('/opt/node/bin/node', '/src/roost');
  const wait = text.indexOf('wait-terminal-owner.mts');
  const start = text.indexOf('backend/src/index.ts');
  assert.ok(wait > 0 && start > wait, '等待必须排在启动之前，否则后端连不上 socket 会退出被反复重试');
  assert.match(text, /^#!\/bin\/sh\nset -eu\n/);
  assert.match(text, /exec /, '用 exec 让 launchd 直接看管后端进程，而不是看管这层 sh');
});

/*
  这一条钉的是真踩过的坑：装服务的人多半正坐在某个 Roost 终端里，而那个终端的 PATH
  带着 `$TMPDIR/roost-cli-launch-XXXX/bin`——会话一结束就没了。照单继承会把这个
  指向空气的路径烤进一个活得比任何 shell 都久的 plist。
*/
test('服务的 PATH 滤掉临时目录、相对项和重复项，node 仍排最前', macOnly, async () => {
  const { servicePath } = await import('../../scripts/install-service.mjs');
  const got = servicePath('/opt/node/bin', [
    '/usr/bin',
    '/var/folders/ls/xx/T/roost-cli-launch-abc/bin',
    '/private/var/folders/ls/xx/T/other/bin',
    'relative/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    '',
  ].join(':'));
  assert.deepEqual(got.split(':'), ['/opt/node/bin', '/usr/bin', '/opt/homebrew/bin']);
});

test('PATH 为空或缺失时也能生成，只剩 node', macOnly, async () => {
  const { servicePath } = await import('../../scripts/install-service.mjs');
  assert.equal(servicePath('/opt/node/bin', undefined), '/opt/node/bin');
  assert.equal(servicePath('/opt/node/bin', ''), '/opt/node/bin');
});

/*
  SPA 兜底不许把 HTML 当脚本发出去。

  `try_files {path} /index.html` 的本意是「前端路由交给 index.html」，但它不挑路径：一个没
  命中的 /x.js 也会拿到一份 HTML，浏览器于是报 'text/html' is not a valid JavaScript MIME
  type ——一句**不说明是哪个地址**的话。2026-09-25 在 iPad 上实际撞到过。

  这里盯的不只是「有没有这条规则」，更是**它会不会静默失效**：Caddy 按自己的固定顺序执行
  指令，rewrite（try_files 就是它）排在 handle 前面。第一版没包 route，路径先被改写成
  /index.html，等匹配器再看时文件已经存在，规则一次都没命中，而配置照样 validate 通过。
*/
test('看起来像文件却不存在的请求回 404，而不是一份 index.html', () => {
  const text = caddyfile({ port: 8080, backendPort: 8787, assetsDir: '/a', webDir: '/w' });
  const spa = text.slice(text.lastIndexOf('handle {'));

  assert.match(spa, /route \{/, 'SPA 兜底那段必须包在 route 里');
  const route = spa.slice(spa.indexOf('route {'));
  const missing = route.indexOf('respond @missingFile');
  const tryFiles = route.indexOf('try_files');
  assert.ok(missing >= 0, '缺少 @missingFile 的 404 分支');
  assert.ok(tryFiles >= 0, 'route 里应当还有 try_files');
  assert.ok(missing < tryFiles,
    'respond 必须写在 try_files 前面：route 按书写顺序执行，写反了路径会先被改写成 /index.html，规则永远不命中');

  assert.match(route, /@viteInternal path \/@\*/, '/@vite/client 这类没有扩展名，要单独挡一条');
  assert.ok(route.indexOf('respond @viteInternal') < tryFiles, '同理要排在 try_files 前面');
});

test('那条正则不能带反斜杠转义或花括号量词——两者都会在生成时被吃掉', () => {
  const text = caddyfile({ port: 8080, backendPort: 8787, assetsDir: '/a', webDir: '/w' });
  const line = text.split('\n').find(l => l.includes('path_regexp') && l.includes('js|'));
  assert.ok(line, '找不到那条扩展名正则');
  assert.match(line, /\[\.\]/, '用 [.] 而不是反斜杠转义：这段要穿过 JS 模板字符串，反斜杠会被吃掉一层');
  assert.doesNotMatch(line, /\{\d/, '别用 {n,m} 量词：花括号在 Caddy 里是占位符语法');
  for (const ext of ['js', 'mjs', 'css', 'wasm', 'json', 'map'])
    assert.ok(line.includes(ext), `扩展名清单里少了 ${ext}`);
});

test('前端路由和真实文件都不受影响', () => {
  const text = caddyfile({ port: 8080, backendPort: 8787, assetsDir: '/a', webDir: '/w' });
  const route = text.slice(text.lastIndexOf('route {'));
  // 判据靠的是「不存在」这一条，所以存在的文件一律照常走 file_server。
  assert.match(route, /not file/, '少了 not file，连存在的 .js 也会被 404 掉');
  assert.match(route, /try_files \{path\} \/index\.html/, '前端路由仍然要落到 index.html');
});
