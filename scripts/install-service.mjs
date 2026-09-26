#!/usr/bin/env node
// 把 Roost 装成 macOS 的登录期服务（launchd user agent）：登录后自动起，
// 异常退出自动拉起，关掉 SSH 或终端窗口都不会停。
//
// 为什么是三个服务而不是一个：PTY 必须活在一个**不会因为改代码而重启**的进程里。
// 后端崩了、重启了、你改了一行代码，正在跑的 CLI 都不该跟着死。所以 terminal 单独
// 一个服务，backend 通过本机 socket 连它；web 那个只是静态文件和反向代理。
//
//   node scripts/install-service.mjs            装上并启动
//   node scripts/install-service.mjs --dry-run  只打印将要写的东西，不动系统
//   node scripts/install-service.mjs --status    看三个服务现在什么状态
//   node scripts/install-service.mjs --uninstall 卸载（不动数据目录）
//
//   --gui-send  打开「从网页把消息写进终端」这条通道（默认关，只影响 terminal 服务）
//
// 常用开关：--port 8080 --backend-port 8787
//           --data-dir ~/.roost --caddy /path/to/caddy --secure-cookies
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = ['terminal', 'backend', 'web'];

const xmlEscape = text => String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function plist(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

const entry = (key, value) => `\t<key>${key}</key>\n\t${value}`;
const strings = list => `<array>\n${list.map(v => `\t\t<string>${xmlEscape(v)}</string>`).join('\n')}\n\t</array>`;
const dict = pairs => `<dict>\n${Object.entries(pairs).map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${xmlEscape(v)}</string>`).join('\n')}\n\t</dict>`;

/**
 * 一个服务的 plist。
 *
 * `WorkingDirectory` 不是可选的：ProgramArguments 里走的是 `deploy/…` 这样的相对
 * 路径，tsx 也要从仓库里解析依赖。
 *
 * `KeepAlive` 配 `ThrottleInterval`：崩溃立刻重启，但两次之间至少隔 10 秒——不然
 * 一个起不来的服务会被 launchd 全速重试，日志刷屏、CPU 打满。
 *
 * `ExitTimeOut` 给 20 秒：终端守护进程收到 SIGTERM 后要把历史落盘再结束 PTY，
 * 默认的 5 秒可能不够，超时会被 SIGKILL，那就是丢输出。
 */
export function servicePlist({ label, args, workingDirectory, env, logPath }) {
  return plist([
    entry('Label', `<string>${xmlEscape(label)}</string>`),
    entry('ProgramArguments', strings(args)),
    entry('WorkingDirectory', `<string>${xmlEscape(workingDirectory)}</string>`),
    entry('EnvironmentVariables', dict(env)),
    entry('RunAtLoad', '<true/>'),
    entry('KeepAlive', '<true/>'),
    entry('ThrottleInterval', '<integer>10</integer>'),
    entry('ExitTimeOut', '<integer>20</integer>'),
    // 0o077：日志和服务写出来的东西只有自己能读。
    entry('Umask', '<integer>63</integer>'),
    entry('StandardOutPath', `<string>${xmlEscape(logPath)}</string>`),
    entry('StandardErrorPath', `<string>${xmlEscape(logPath)}</string>`),
  ].join('\n'));
}

/**
 * Caddy 配置。
 *
 * `/assets/*` 指向**共享资产目录**而不是 `frontend/dist/assets`：哈希资产只增不删，
 * 这样一次发布不会让已经打开的标签页加载不到它正在用的懒加载块。用
 * `deploy/publish-assets.mjs` 往那儿推，别用 cp。
 */
export function caddyfile({ port, backendPort, assetsDir, webDir }) {
  return `{
    admin off
    auto_https off
}
http://:${port} {
    encode zstd gzip
    header X-Content-Type-Options nosniff
    @api path /api /api/*
    handle @api {
        reverse_proxy 127.0.0.1:${backendPort}
    }
    # 应用用绝对路径引资源时，靠 Referer 转回后端的代理。
    #
    # 少了这一条，浮动窗口里的应用会白屏：应用生成的是 /@vite/client、/assets/x.js
    # 这种从根算起的地址，前缀丢了，而下面那条 try_files … /index.html 会把它们一律
    # 当成前端路由，回一份 roost 自己的 index.html——iframe 里拿到的是 roost 的页面
    # 而不是那个脚本，浏览器只报一句 MIME 不对。
    #
    # 判据单向且安全：roost 自己的页面永远不会带上 /api/app/<端口>/ 的 Referer，
    # 所以它的资源不会被劫到应用那边。真正的判断在后端 app-proxy.ts，这里只负责把
    # 这类请求送过去——caddy 默认只转 /api/*，不加这条它根本到不了后端。
    @appReferer header_regexp Referer ^https?://[^/]+/api/app/[0-9]{1,5}/
    handle @appReferer {
        reverse_proxy 127.0.0.1:${backendPort}
    }
    handle_path /assets/* {
        root * ${JSON.stringify(assetsDir)}
        @assetFile {
            not path */
            file {path}
        }
        handle @assetFile {
            header Cache-Control "public, max-age=31536000, immutable"
            # 预压缩优先：deploy/publish-assets.mjs 会给每个够大的资产生成同名 .br，
            # 请求带 br 时直接发它，没有才回落到站点级 encode 的即时 gzip。
            # 实测 main chunk 246 KB(gzip) → 188 KB(br)，wasm 3712 → 2492 KB。
            file_server {
                precompressed br gzip
            }
        }
        handle {
            header Cache-Control no-store
            respond "Asset not found" 404
        }
    }
    handle {
        # **不要把这里指回 frontend/dist。** 那样 npm run build 就直接写进了线上：它会
        # 先把外壳换成指向新哈希的版本，而那些哈希还要等发布才到位，中间这段时间入口脚本
        # 404、页面纯白。两天内栽了三次。现在外壳也由 deploy/publish.mjs 发布，构建碰不到线上。
        root * ${JSON.stringify(webDir)}
        header Cache-Control no-store
        # **看起来像文件、而文件又不存在的请求，老实回 404。**
        #
        # try_files … /index.html 的本意是「前端路由交给 index.html」，但它不挑路径：
        # 一个没命中的 /x.js 也会拿到一份 HTML，于是浏览器报的是
        # 'text/html' is not a valid JavaScript MIME type ——一句**不说明是哪个地址**的话。
        # 2026-09-25 在 iPad 上实际撞到过，查了半天才定位到是兜底规则。
        #
        # 前端路由不带文件扩展名，所以判据很干净。换来的是浏览器直接在控制台打出那个
        # 404 的 URL，下一次同类问题自己就说清楚了。
        #
        # **必须包在 route 里。** Caddy 按自己的固定顺序执行指令，rewrite（try_files 就是
        # 它）排在 handle 前面——不包起来的话路径先被改写成 /index.html，等匹配器再看时
        # 文件已经存在，这条规则永远不命中。第一版就是这么静默失效的。
        #
        # 正则里用 [.] 而不是反斜杠转义：这段要穿过 JS 模板字符串才落到文件里，反斜杠会被
        # 吃掉一层。也不用 {n,m} 量词——花括号在 Caddy 里是占位符语法。
        route {
            @missingFile {
                path_regexp [.](js|mjs|cjs|css|map|json|wasm|woff2|woff|ttf|otf|svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$
                not file
            }
            respond @missingFile "Not found" 404
            # Vite 的内部路径（/@vite/client、/@fs/…、/@id/…）没有扩展名，上面那条盖不住。
            # roost 自己没有任何以 /@ 开头的路由，所以一律 404 比回一份 HTML 诚实——
            # 它们只会出现在浮动窗口代理的应用里，而那条路该由上面的 Referer 规则接走。
            @viteInternal path /@*
            respond @viteInternal "Not found" 404
            try_files {path} /index.html
            file_server
        }
    }
}
`;
}

/**
 * 后端的启动脚本。
 *
 * 先跑 `wait-terminal-owner.mts` 再起后端，**顺序是有意义的**：后端启动时要连上
 * 终端守护进程的本机 socket，owner 还没就绪的话它会失败退出、被 launchd 重试，
 * 表现为启动那几秒里页面反复断连。等一下比重试便宜。
 */
export const backendScript = (node, repo) => `#!/bin/sh
set -eu
cd ${JSON.stringify(repo)}
${JSON.stringify(node)} --import tsx deploy/wait-terminal-owner.mts
exec ${JSON.stringify(node)} --import tsx backend/src/index.ts
`;

/**
 * 服务要用的 PATH。
 *
 * **不能整个继承当前 shell 的。** 装这个服务的人多半正坐在某个终端里，而那个终端
 * 的 PATH 可能带着只在这次会话里存在的目录——Roost 自己给 CLI 准备的那个
 * `$TMPDIR/roost-cli-launch-XXXX/bin` 就是。烤进 plist 之后它指向一个会消失的地方，
 * 而 launchd 服务活得比任何 shell 都久。
 *
 * 但也不该换成一张硬编码的清单：用户的 claude / codex / opencode 到底装在哪，
 * 他自己的 PATH 才知道。所以照单收下，只滤掉会消失的和重复的。
 */
export function servicePath(nodeBin, inherited) {
  const ephemeral = [resolve(tmpdir()), '/var/folders/', '/private/var/folders/'];
  const seen = new Set();
  return [nodeBin, ...String(inherited ?? '').split(':')]
    .map(entry => entry.trim())
    // 相对路径在服务里没有意义：launchd 的工作目录和你当时那个 shell 无关。
    .filter(entry => entry.startsWith('/'))
    .filter(entry => !ephemeral.some(prefix => entry === prefix.replace(/\/$/, '') || entry.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')))
    .filter(entry => (seen.has(entry) ? false : seen.add(entry)))
    .join(':');
}

export function plan(options) {
  const { node, repo, dataDir, installDir, port, backendPort, insecureHttp, guiSend, shell, caddy, pathEntries } = options;
  const logs = join(dataDir, 'logs');
  const env = {
    PATH: servicePath(dirname(node), pathEntries),
    HOST: '127.0.0.1',
    PORT: String(backendPort),
    SHELL: shell,
    ROOST_DATA_DIR: dataDir,
    ...(insecureHttp ? { ROOST_AUTH_INSECURE_HTTP: '1' } : {}),
  };
  const startBackend = join(installDir, 'start-backend.sh');
  const caddyConfig = join(installDir, 'Caddyfile');
  return {
    files: [
      { path: caddyConfig, content: caddyfile({ port, backendPort, assetsDir: join(installDir, 'assets'), webDir: join(installDir, 'web') }), mode: 0o600 },
      { path: startBackend, content: backendScript(node, repo), mode: 0o700 },
    ],
    services: [
      /*
        `ROOST_CLAUDE_GUI_SEND` **只给 terminal 这一个服务**，不进共用的 env。

        读它的是守护进程里的 AI 命令 owner（`terminal-daemon/src/owner.ts`），也只有它会
        往 PTY 写字节。后端和 Caddy 拿到这个变量没有任何用处，而一个「允许往用户终端里
        打字」的开关，出现在不需要它的进程环境里本身就是噪音——以后查「谁有这个能力」时
        会多两个假线索。
      */
      { name: 'terminal', label: 'com.roost.terminal', args: [node, '--import', 'tsx', 'deploy/terminal-owner.mts'],
        env: guiSend ? { ROOST_CLAUDE_GUI_SEND: '1' } : undefined },
      { name: 'backend', label: 'com.roost.backend', args: ['/bin/sh', startBackend] },
      { name: 'web', label: 'com.roost.web', args: [caddy, 'run', '--config', caddyConfig, '--adapter', 'caddyfile'] },
    ].map(s => ({ ...s, plist: servicePlist({ label: s.label, args: s.args, workingDirectory: repo, env: { ...env, ...s.env }, logPath: join(logs, `${s.name}.log`) }) })),
  };
}

function parseArgs(argv) {
  const flags = new Set(), values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const [name, inline] = item.slice(2).split('=');
    const next = inline ?? (argv[i + 1]?.startsWith('--') ? undefined : argv[++i]);
    if (next === undefined) flags.add(name); else values.set(name, next);
  }
  return { flags, values };
}

const expand = path => path.replace(/^~(?=$|\/)/, homedir());

async function findCaddy(given) {
  if (given) return expand(given);
  for (const candidate of [join(homedir(), '.local/share/roost/bin/caddy'), '/opt/homebrew/bin/caddy', '/usr/local/bin/caddy']) {
    try { await readFile(candidate); return candidate; } catch { /* try the next one */ }
  }
  const found = await run('sh', ['-c', 'command -v caddy || true']).then(r => r.stdout.trim(), () => '');
  if (found) return found;
  throw new Error(
    '找不到 caddy。它负责提供前端并把 /api 反代给后端。\n' +
    '  装一个：brew install caddy\n' +
    '  或者已经有了就指出来：--caddy /path/to/caddy');
}

const agents = join(homedir(), 'Library/LaunchAgents');
const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => run('launchctl', args).catch(error => ({ stdout: '', stderr: String(error.stderr ?? error) }));

async function status() {
  for (const name of SERVICES) {
    const { stdout } = await launchctl('print', `${domain()}/com.roost.${name}`);
    const state = stdout.match(/state = (\S+)/)?.[1] ?? '未装载';
    console.log(`com.roost.${name.padEnd(9)} ${state}`);
  }
}

async function uninstall() {
  for (const name of SERVICES) await launchctl('bootout', `${domain()}/com.roost.${name}`);
  for (const name of SERVICES) await rm(join(agents, `com.roost.${name}.plist`), { force: true });
  console.log('已卸载三个服务。数据目录没有动。');
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has('status')) return status();
  if (flags.has('uninstall')) return uninstall();

  const dataDir = resolve(expand(values.get('data-dir') ?? join(homedir(), '.roost')));
  const installDir = resolve(expand(values.get('install-dir') ?? join(homedir(), '.local/share/roost')));
  const port = Number(values.get('port') ?? 8080);
  const backendPort = Number(values.get('backend-port') ?? 8787);
  /*
    `--origins` 已经废弃：来源判定改成了「`Origin` 等于请求自己的 `Host`」，不再需要名单。
    还接着这个开关只为不让老命令行报错——传了就说一声它没用了。

    名单为什么被删：后端在反向代理后面，caddy 保留原始 `Host: <地址>:8080` 转给
    127.0.0.1:8787，于是「Host 端口 === 本地端口」永远对不上，只能靠名单开后门。结果它
    变成必须手工维护的东西——换网段、多一个 Tailscale 地址、以后加域名都要改；漏了就是
    整个连不上而且报 403。2026-09-22 就这么坏过一次：一次安装重写 plist 丢了局域网地址，
    页面打得开（静态外壳走 caddy）而所有 WebSocket 全挂。见 backend/src/access.ts。
  */
  if (values.get('origins')) console.warn('--origins 已废弃：来源判定改为同源比对，不再需要名单，这个值被忽略了');
  /*
    默认放行明文 HTTP。这是个本机工具，入口就是 http://localhost——要求 secure cookie
    的话登录直接不可用。但它确实降低了安全性，所以要说出来，并且给一个关掉的开关。
  */
  const insecureHttp = !flags.has('secure-cookies');
  /*
    `--gui-send` 打开「从网页把消息写进终端」这条通道，默认关。

    它让守护进程可以往一条活着的 PTY 里粘贴文本并补一个回车。写入本身有层层门禁
    （输入框必须空着、画面必须稳定、权限弹窗一律不写、绝不自动批准），但这些是**写入时**
    的判据；**有没有这个能力**是另一回事，所以做成显式开关，而不是默认给。
  */
  const guiSend = flags.has('gui-send');
  const options = {
    node: process.execPath, repo: REPO, dataDir, installDir, port, backendPort, insecureHttp, guiSend,
    shell: process.env.SHELL || '/bin/zsh',
    caddy: await findCaddy(values.get('caddy')),
    pathEntries: process.env.PATH ?? '',
  };
  const { files, services } = plan(options);

  if (flags.has('dry-run')) {
    for (const file of files) console.log(`\n--- ${file.path}\n${file.content}`);
    for (const service of services) console.log(`\n--- ${join(agents, `${service.label}.plist`)}\n${service.plist}`);
    return;
  }

  await mkdir(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(join(installDir, 'assets'), { recursive: true, mode: 0o700 });
  await mkdir(join(installDir, 'web'), { recursive: true, mode: 0o700 });
  await mkdir(agents, { recursive: true });
  for (const file of files) { await writeFile(file.path, file.content); await chmod(file.path, file.mode); }
  for (const service of services) {
    const path = join(agents, `${service.label}.plist`);
    await writeFile(path, service.plist, { mode: 0o644 });
    // 宁可在装载之前就报错：一个语法坏掉的 plist 被 launchd 拒绝时的提示很难读懂。
    await run('plutil', ['-lint', path]);
  }
  /*
    先全部 bootout 再全部 bootstrap，不要一个个来。三者之间有依赖（backend 等
    terminal），混着起会让后端在 owner 还没就绪时启动，然后被 launchd 重试。
  */
  for (const service of services) await launchctl('bootout', `${domain()}/${service.label}`);
  for (const service of services) {
    const { stderr } = await launchctl('bootstrap', domain(), join(agents, `${service.label}.plist`));
    if (stderr) console.error(`${service.label}: ${stderr.trim()}`);
  }
  await status();
  console.log(`\n入口 http://localhost:${port}`);
  console.log(`密码 cat ${join(dataDir, 'auth-password')}`);
  console.log(`日志 ${join(dataDir, 'logs')}`);
  if (insecureHttp) console.log('\n注意：已放行明文 HTTP 的登录 cookie。这台机器之外的人能访问到这个端口的话，请在反向代理那层再加一道访问控制。');
  console.log('\n还没发布过前端的话，Caddy 会 404：npm run build --workspace frontend && npm run publish 然后');
  console.log(`node deploy/publish-assets.mjs --target ${join(installDir, 'assets')} frontend/dist/assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
