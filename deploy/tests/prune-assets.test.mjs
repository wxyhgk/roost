/*
  prune-assets 的测试。这个脚本会 unlink，所以这里盯的不是「删得干不干净」，而是
  **每一种「不该删却删了」的路径**：可达性算漏、`.br` 和源文件脱钩、闸门失灵。
  留多了只是省得少，删错了是线上 404。
*/
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { HASHED, REFERENCE, TEXTUAL, assertSane, closure, planPrune, referencedNames, sourceOf } from '../prune-assets.mjs';

const set = (...names) => new Set(names);

test('三种引用形式——HTML 的绝对路径、chunk 之间的相对 import、CSS 的 url()——都按名字认出来', () => {
  const names = referencedNames(`
    <script src="/assets/main-B7P0L72O.js"></script>
    import("./FilesView-CO4JxlM_.js");
    @font-face { src: url(/assets/ibm-plex-mono-400-latin-BJoXLJYV.woff2) }
  `);
  ok(names.has('main-B7P0L72O.js'));
  ok(names.has('FilesView-CO4JxlM_.js'));
  ok(names.has('ibm-plex-mono-400-latin-BJoXLJYV.woff2'));
});

test('同一段文本连问两次答案一样——REFERENCE 带 g，用错会因为 lastIndex 变成有状态的', () => {
  const text = 'a-AAAAAAAA.js b-BBBBBBBB.css';
  deepEqual([...referencedNames(text)], [...referencedNames(text)]);
  equal(HASHED.test('a-AAAAAAAA.js'), HASHED.test('a-AAAAAAAA.js'));
});

test('可达性是传递的：外壳只引入口，入口引的块也算活', async () => {
  const published = set('entry-AAAAAAAA.js', 'lazy-BBBBBBBB.js', 'deep-CCCCCCCC.js');
  const bodies = {
    'entry-AAAAAAAA.js': 'import("./lazy-BBBBBBBB.js")',
    'lazy-BBBBBBBB.js': 'import("./deep-CCCCCCCC.js")',
    'deep-CCCCCCCC.js': '',
  };
  const reached = await closure({ roots: ['<script src="/assets/entry-AAAAAAAA.js">'], published, read: async name => bodies[name] ?? null });
  deepEqual([...reached].sort(), ['deep-CCCCCCCC.js', 'entry-AAAAAAAA.js', 'lazy-BBBBBBBB.js']);
});

test('没发布过的 token 被忽略——chunk 里那种 D.style.css 噪声不该把集合撑大', async () => {
  const published = set('entry-AAAAAAAA.js');
  const reached = await closure({ roots: ['entry-AAAAAAAA.js D.style.css missing-ZZZZZZZZ.js'], published, read: async () => '' });
  deepEqual([...reached], ['entry-AAAAAAAA.js']);
});

test('二进制当叶子：read 返回 null 不算错误，只是不往下走', async () => {
  const published = set('font-AAAAAAAA.woff2');
  const reached = await closure({ roots: ['url(/assets/font-AAAAAAAA.woff2)'], published, read: async () => { throw new Error('不该读它'); } });
  deepEqual([...reached], ['font-AAAAAAAA.woff2']);
});

test('互相引用的两个块不会把闭包转成死循环', async () => {
  const published = set('a-AAAAAAAA.js', 'b-BBBBBBBB.js');
  const bodies = { 'a-AAAAAAAA.js': 'b-BBBBBBBB.js', 'b-BBBBBBBB.js': 'a-AAAAAAAA.js' };
  const reached = await closure({ roots: ['a-AAAAAAAA.js'], published, read: async name => bodies[name] });
  equal(reached.size, 2);
});

const plan = (published, reachable, mtimes, keepMs = 1000) =>
  planPrune({ published: set(...published), reachable: set(...reachable), mtimes: new Map(mtimes), now: 10_000, keepMs });

test('可达就留，哪怕它是很久以前发布的——复用的块 mtime 停在第一次发布那天', () => {
  const { keep, remove } = plan(['old-AAAAAAAA.js'], ['old-AAAAAAAA.js'], [['old-AAAAAAAA.js', 0]]);
  deepEqual([...keep], ['old-AAAAAAAA.js']);
  deepEqual(remove, []);
});

test('不可达但在宽限窗口内也留：别的设备可能还开着上一版外壳', () => {
  const { remove } = plan(['recent-AAAAAAAA.js'], [], [['recent-AAAAAAAA.js', 9500]]);
  deepEqual(remove, []);
});

test('既不可达又超出窗口才删', () => {
  const { remove } = plan(['stale-AAAAAAAA.js'], [], [['stale-AAAAAAAA.js', 8000]]);
  deepEqual(remove, ['stale-AAAAAAAA.js']);
});

test('刚好等于窗口边界算过期——窗口是左闭右开的', () => {
  const { remove } = plan(['edge-AAAAAAAA.js'], [], [['edge-AAAAAAAA.js', 9000]]);
  deepEqual(remove, ['edge-AAAAAAAA.js']);
});

test('.br 跟着源文件走：源文件因为可达留下，压缩副本再旧也跟着留', () => {
  const { remove } = plan(
    ['live-AAAAAAAA.js', 'live-AAAAAAAA.js.br'],
    ['live-AAAAAAAA.js'],
    [['live-AAAAAAAA.js', 0], ['live-AAAAAAAA.js.br', 0]],
  );
  deepEqual(remove, []);
});

test('反过来也成立：源文件该删，它的 .br 哪怕很新也一起删，不留下没人要的压缩副本', () => {
  const { remove } = plan(
    ['dead-AAAAAAAA.js', 'dead-AAAAAAAA.js.br'],
    [],
    [['dead-AAAAAAAA.js', 0], ['dead-AAAAAAAA.js.br', 9999]],
  );
  deepEqual(remove, ['dead-AAAAAAAA.js', 'dead-AAAAAAAA.js.br']);
});

test('没有对应源文件的孤儿 .br 按自己的 mtime 判', () => {
  const fresh = plan(['orphan-AAAAAAAA.js.br'], [], [['orphan-AAAAAAAA.js.br', 9500]]);
  deepEqual(fresh.remove, []);
  const stale = plan(['orphan-AAAAAAAA.js.br'], [], [['orphan-AAAAAAAA.js.br', 0]]);
  deepEqual(stale.remove, ['orphan-AAAAAAAA.js.br']);
});

test('sourceOf 只剥 .br，别的扩展名原样', () => {
  equal(sourceOf('x-AAAAAAAA.js.br'), 'x-AAAAAAAA.js');
  equal(sourceOf('x-AAAAAAAA.js'), 'x-AAAAAAAA.js');
});

test('mtime 查不到的文件当过期，不会因为缺信息而永久留着', () => {
  const { remove } = plan(['unknown-AAAAAAAA.js'], [], []);
  deepEqual(remove, ['unknown-AAAAAAAA.js']);
});

test('外壳没有 index.html 时拒绝往下走', () => {
  throws(() => assertSane({ shell: false, published: set(), reachable: set('a'), direct: set() }), /index\.html/);
});

test('可达集合是空的时候拒绝往下走——这正是会把整个目录扫空的那条路径', () => {
  throws(() => assertSane({ shell: true, published: set('a-AAAAAAAA.js'), reachable: set(), direct: set() }), /一个资产都没引到/);
});

test('外壳引的资产已经不在盘上时拒绝往下走：install 本来就坏了，此时更不该删', () => {
  throws(
    () => assertSane({ shell: true, published: set('here-AAAAAAAA.js'), reachable: set('here-AAAAAAAA.js'), direct: set('gone-BBBBBBBB.js') }),
    /已经不在盘上/,
  );
});

test('三道闸都过了就放行', () => {
  assertSane({ shell: true, published: set('a-AAAAAAAA.js'), reachable: set('a-AAAAAAAA.js'), direct: set('a-AAAAAAAA.js') });
});

test('TEXTUAL 认得 js/css/html，不认字体和 wasm', () => {
  ok(TEXTUAL.test('a-AAAAAAAA.js'));
  ok(TEXTUAL.test('a-AAAAAAAA.css'));
  ok(!TEXTUAL.test('a-AAAAAAAA.woff2'));
  ok(!TEXTUAL.test('a-AAAAAAAA.wasm'));
});

test('REFERENCE 认得 wasm 和字体——漏认一种扩展名就等于删掉那一类活文件', () => {
  ok(referencedNames('indigo-ketcher-1.46.0-f_xBxuuS.wasm').has('indigo-ketcher-1.46.0-f_xBxuuS.wasm'));
  ok(referencedNames('x-AAAAAAAA.woff2').has('x-AAAAAAAA.woff2'));
  ok(referencedNames('x-AAAAAAAA.ttf').has('x-AAAAAAAA.ttf'));
});
