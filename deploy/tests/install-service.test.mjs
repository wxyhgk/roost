import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('每个 plist 都是合法的，并带齐 launchd 需要的键', async () => {
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

test('环境变量把数据目录、端口和来源传下去，node 排在 PATH 最前', async () => {
  const { EnvironmentVariables: env } = await parse(plan(options).services[0].plist);
  assert.equal(env.ROOST_DATA_DIR, options.dataDir);
  assert.equal(env.PORT, '8787');
  assert.equal(env.ROOST_ALLOWED_ORIGINS, 'http://127.0.0.1:8080,http://localhost:8080');
  assert.equal(env.SHELL, '/bin/zsh');
  // 服务里跑的 node 必须是安装时那一个，不能撞上 PATH 上别的版本。
  assert.deepEqual(env.PATH.split(':'), ['/opt/node/bin', '/usr/bin', '/bin']);
});

test('--secure-cookies 时不注入放行明文 HTTP 的变量', async () => {
  const on = await parse(plan(options).services[0].plist);
  assert.equal(on.EnvironmentVariables.ROOST_AUTH_INSECURE_HTTP, '1');
  const off = await parse(plan({ ...options, insecureHttp: false }).services[0].plist);
  assert.equal('ROOST_AUTH_INSECURE_HTTP' in off.EnvironmentVariables, false);
});

test('plist 里的值转义 XML，含 & 和 < 的路径不会把文件写坏', async () => {
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
test('服务的 PATH 滤掉临时目录、相对项和重复项，node 仍排最前', async () => {
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

test('PATH 为空或缺失时也能生成，只剩 node', async () => {
  const { servicePath } = await import('../../scripts/install-service.mjs');
  assert.equal(servicePath('/opt/node/bin', undefined), '/opt/node/bin');
  assert.equal(servicePath('/opt/node/bin', ''), '/opt/node/bin');
});
