/*
  状态栏那个主机名不许回落到浏览器地址。

  `summary.host.hostname` 回答「这台机器叫什么」，`location.hostname` 回答「我的浏览器连到
  哪个地址」——两个不同的问题。一度写成 `summary?.host.hostname ?? location.hostname`：监控
  读数断一下，机器就像自己改了名，变成一串地址；而状态栏宽度会被挤，截断之后只剩前几个
  字符（实测本机访问时显示成回环地址、400px 宽下可见 20px / 内容 52px），看上去莫名其妙。

  它还是一条**不泄露地址**的守卫：从公网地址访问时，那个回落会把真实 IP 摆在界面上。

  这条用例扫的是源码而不是渲染结果，因为要挡的正是「有人把那个回落写回去」。
*/
import { equal, match, doesNotMatch, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/*
  先把注释抹掉再扫。这条用例本身要挡的字眼，恰恰会被写进解释它的注释里——第一版就是这么
  自己把自己绊倒的。（`scripts/check-boundaries.mjs` 里那个写死值检查是同样的做法。）
*/
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const statusBar = code(readFileSync(new URL('../src/app/StatusBar.tsx', import.meta.url).pathname, 'utf8'));

test('状态栏的主机名不碰 location，断了就用记住的那个', () => {
  doesNotMatch(statusBar, /location\.hostname/,
    'StatusBar 又拿 location.hostname 当主机名了——那是浏览器连到哪，不是这台机器叫什么');
  doesNotMatch(statusBar, /location\.host\b/, 'location.host 同理');
  match(statusBar, /summary\?\.host\.hostname\s*\?\?\s*lastHost\.current\s*\?\?/,
    '拿不到读数时应当回落到上一次记住的名字，最后才是占位符');
});

test('访问地址那处保留 location.host——它问的就是那个问题', () => {
  const monitor = code(readFileSync(new URL('../src/features/server-monitor/ServerMonitorView.tsx', import.meta.url).pathname, 'utf8'));
  const line = monitor.split('\n').find(l => /accessAddress/.test(l));
  ok(line, '面板里应当还有「访问地址」那一项');
  match(line!, /location\.host\b/, '访问地址就该显示浏览器连的那个地址，别把它一起改掉');
});

test('整个前端里 location.hostname/host 只许出现在说得清的地方', () => {
  const session = code(readFileSync(new URL('../src/shared/api/session.ts', import.meta.url).pathname, 'utf8'));
  match(session, /location\.host\b/, 'WebSocket 地址要按当前页面拼，这处是对的');
  equal((session.match(/location\.host\b/g) ?? []).length, 1, '多出来的用法要单独看一眼');
});
