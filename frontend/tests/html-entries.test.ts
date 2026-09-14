import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
  三个 html 入口的**结构**守卫。

  起因是一次真实事故（e82b0a8）：删 fonts.googleapis.com 那条 <link> 时用的是
  「从这里切到下一个 <script type="module">」，而源文件里那个 script 在 </body> 之前——
  于是 </head>、<body>、<div id="root"> 三行被一起切掉了。

  当时的断言只检查了「被删掉的文本**包含**字体那几行」，那是个下界，没有上界。

  而这条 bug 一路穿过了所有关卡：`document.getElementById("root")!` 是非空断言，tsc 拦不住；
  vite 只是把 script 注入到 <html> 和 <head> 之间，结构明显坏了但不算错误，构建照样成功；
  资产全是 200，首屏外部请求数也确实是 0。**每一条检查都在看我改的东西，没有一条在看我可能
  弄坏的东西。** 运行时才炸：createRoot(null) → React #299。

  所以这里钉的是「页面还挂得上去吗」，跑一次几毫秒。
*/
const ROOT = join(import.meta.dirname, '..');
const ENTRIES = [
  { file: 'index.html', script: '/src/main.tsx' },
  { file: 'molecule.html', script: '/src/embeds/molecule/bootstrap.ts' },
  { file: 'stable.html', script: '/src/stable-main.ts' },
];

for (const { file, script } of ENTRIES) {
  test(`${file} 的挂载点和文档结构完整`, () => {
    const html = readFileSync(join(ROOT, file), 'utf8');
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      assert.notEqual(i, -1, `${file} 缺少 ${needle}`);
      return i;
    };
    const head = at('</head>'), body = at('<body'), root = at('id="root"'), end = at('</body>');
    assert.ok(head < body, '</head> 必须在 <body> 之前');
    assert.ok(body < root && root < end, '挂载点必须在 body 里——createRoot(null) 只有运行时才炸');
    assert.equal(html.match(/id="root"/g)?.length, 1, '挂载点只能有一个');
    const src = at(`src="${script}"`);
    assert.ok(body < src && src < end, `${script} 必须在 body 里`);
    assert.ok(html.trimEnd().endsWith('</html>'), '文档没有正常收尾');
  });
}

/*
  首屏不许有跨域资源。字体自托管之前这里是一条指向 fonts.googleapis.com 的**渲染阻塞**
  样式表：国内连不上那个域名，浏览器要等到超时才开始画；桌面版的 CSP 也从来不允许它。
  理由细节见 src/index.css 顶部那段。注释里可以提域名，代码里不行。
*/
test('index.html 里没有跨域资源引用', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const code = html.replace(/<!--[\s\S]*?-->/g, '');
  const external = [...code.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/g)].map(m => m[1]);
  assert.deepEqual(external, [], '外链会把白屏和桌面版的字体一起放回来');
});
