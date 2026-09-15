/*
  分子编辑器的冒烟检查：真浏览器里起一次 molecule.html，做一次 mol 往返 + 出图。

    npm run build --workspace frontend && node scripts/smoke-molecule.mjs

  **为什么需要它。** vite.config.ts 里有两处给 ketcher 打的补丁（raphael 的 require 互操作、
  把 3.9 MB 的高分子单体库换成空库），两处都改的是 node_modules 里的东西，而 node 那边的
  单测一行都覆盖不到——它们出事的样子是「编辑器一片白」，只有真浏览器看得见。

  没进 verify：它要 Chrome，跑一次约 30 秒，而 verify 是每次提交前都跑的。补丁失效这件事
  已经由构建期的断言当场报错了，这个脚本管的是另一半——补丁生效、但编辑器被它弄坏了。
  升级 ketcher 或者动那两个补丁时手动跑一次。
*/
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = new URL('../frontend/dist/', import.meta.url);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

// 苯环。6 个碳、交替单双键——够让 indigo 真的解析一遍，又短到能写在源码里。
const BENZENE = ['', '  smoke', '', '  6  6  0  0  0  0  0  0  0  0999 V2000',
  ...[[1.2, 0, 0], [0.6, 1.04, 0], [-0.6, 1.04, 0], [-1.2, 0, 0], [-0.6, -1.04, 0], [0.6, -1.04, 0]]
    .map(([x, y, z]) => `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${z.toFixed(4).padStart(10)} C   0  0  0  0  0  0  0  0  0  0  0  0`),
  '  1  2  2  0', '  2  3  1  0', '  3  4  2  0', '  4  5  1  0', '  5  6  2  0', '  6  1  1  0', 'M  END'].join('\n');

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(new URL(path, DIST));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // favicon.ico 之类的缺失不算事，页面自己的资源缺了会在控制台错误里暴露出来。
    res.writeHead(404).end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'roost-smoke-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = async () => { chrome.kill(); server.close(); await rm(profile, { recursive: true, force: true }); };
const fail = async (message) => { console.error('✗ ' + message); await cleanup(); process.exit(1); };

// Chrome 把调试端口写在 stderr 第一行。给 0 让它自己挑，避免和别人抢 9222。
const devtools = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome 没报出调试端口')), 20_000);
  chrome.stderr.on('data', data => {
    const found = /DevTools listening on (ws:\/\/\S+)/.exec(String(data));
    if (found) { clearTimeout(timer); resolve(found[1]); }
  });
});
const httpBase = devtools.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*/, '');
const target = await (await fetch(`${httpBase}/json/new?${base}/molecule.html`, { method: 'PUT' })).json();

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const errors = [];
socket.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(`${message.params.entry.text} ${message.params.entry.url ?? ''}`.trim());
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
});
const send = (method, params) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
await new Promise(resolve => socket.on('open', resolve));
await send('Runtime.enable');
await send('Log.enable');

// 等的是 frame.tsx 在 onInit 里挂上的那个桥——它出现就说明 ketcher 真的初始化完了。
// indigo 的 wasm 有 11 MB，冷启动慢，所以给到 120 秒。
const evaluated = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const deadline = Date.now() + 120000;
    while (!window.moleculeEditor && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    if (!window.moleculeEditor) return { ok: false, why: 'moleculeEditor 一直没出现：onInit 没跑到' };
    await window.moleculeEditor.load(${JSON.stringify(BENZENE)}, 'mol');
    const molfile = await window.moleculeEditor.save();
    const image = await window.moleculeEditor.image();
    return { ok: true, carbons: (molfile.match(/ C   0  0/g) || []).length, png: image.size };
  })()`,
});
const result = evaluated.result?.result?.value;
if (!result) await fail(`浏览器里没拿到结果：${JSON.stringify(evaluated).slice(0, 400)}`);
if (!result.ok) await fail(result.why);
if (result.carbons !== 6) await fail(`存回来的 molfile 里有 ${result.carbons} 个碳，应该是 6 个`);
if (!(result.png > 0)) await fail('image() 没出图');
// 页面自己的资源缺了会在这里现形；favicon.ico 那种由静态服务器兜底，不进这个列表。
const real = errors.filter(text => !/favicon/.test(text));
if (real.length) await fail('控制台有错误：\n' + real.join('\n'));

console.log(`✓ 分子编辑器起得来：mol 往返 6 个碳、image() 出了 ${result.png} 字节 PNG、控制台无错误`);
await cleanup();
