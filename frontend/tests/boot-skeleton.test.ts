/*
  首屏骨架必须和真外壳对得上。

  `index.html` 里那块骨架是**手抄**的字面值：tokens.css 在首屏那 281 KB 里，画骨架的时候
  还没到，写 `var(--color-bar)` 只会拿到空值、得到一块白。手抄就会漂移——改了 tokens.css
  忘了改 index.html，下次冷加载就是「先闪一个旧配色的外壳，再跳成新的」，比白屏更难看。

  所以这条用例把两边钉在一起：颜色对 tokens.css，尺寸对各自的样式源（顶栏/图标栏是
  Tailwind 的 h-10/w-10，状态栏是 statusBar.css）。它挡的是漂移，不是渲染，所以扫源码。
*/
import { equal, match, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url).pathname, 'utf8');
const html = read('../index.html');
const tokens = read('../src/styles/tokens.css');
const statusBarCss = read('../src/app/statusBar.css');

/*
  tokens.css 里某个变量的值。`scope` 是它所在的块的起始文本。

  深色那套在 `@theme` 里（Tailwind v4 的写法），不是 `:root`——文件里确实有个 `:root`，
  但那是另一块，照着直觉写会一个变量都取不到。
*/
function token(scope: string, name: string): string {
  const from = tokens.indexOf(scope);
  ok(from >= 0, `tokens.css 里找不到 ${scope}`);
  // 注释里会提到这些变量名，先抹掉再数，否则「只定义一次」会被解释文字绊倒。
  const block = tokens.slice(from, tokens.indexOf('\n}', from)).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const hits = [...block.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))];
  equal(hits.length, 1, `${scope} 里 --${name} 应当只定义一次`);
  return hits[0][1].trim();
}

/*
  index.html 的内联样式里某条规则的值。

  **按完整选择器取，不做子串匹配。** 第一版拿 `.boot-bar` 去搜，深色那条和浅色那条合并
  规则各命中一次，于是「只有一条」当场不成立——而真正要问的是「哪条规则的选择器就是它」。
*/
const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
// @media 块单独处理（见下面触屏那段），先从顶层规则里拿掉，免得把嵌套的花括号算进来。
const topLevel = styleBlock
  .replace(/\/\*[\s\S]*?\*\//g, ' ')  // 注释会粘在下一条规则的选择器上
  .replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, ' ');
function boot(selector: string, property: string): string {
  const hits = [...topLevel.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(m => m[1].split(',').map(s => s.trim()).includes(selector));
  equal(hits.length, 1, `index.html 里 ${selector} 应当只有一条规则`);
  const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(hits[0][2]);
  ok(value, `${selector} 里没有 ${property}`);
  return value![1].trim();
}

test('骨架挂在 #root 里面——靠 React 首次提交清掉，不需要谁来删', () => {
  /*
    **锚在「紧跟 #root 开标签之后」，不是「#root 里面有它」。** 第一版取 `#root` 开合标签
    之间的内容再搜 `class="boot"`，而惰性正则会一路吃到 `<script>` 前最后一个 `</div>`：
    把骨架挪到 #root 外面照样通过——恰恰是这条用例唯一要挡的那件事。
  */
  match(html, /<div id="root">\s*<div class="boot" aria-hidden="true">/,
    '骨架要紧跟在 #root 开标签后面：createRoot 首次提交会清空容器，放外面就得自己删，' +
    '而那是另一处会忘的地方；aria-hidden 也别丢，它是纯装饰');
  equal([...html.matchAll(/class="boot"/g)].length, 1, '骨架只该有一处');
});

test('骨架的样式是内联的——外链就又变成一次往返，等于没做', () => {
  match(html, /<style>[\s\S]*\.boot\b/, '骨架样式应当写在 index.html 的 <style> 里');
  const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"/g)];
  equal(sheets.length, 0, 'index.html 不该有渲染阻塞的外部样式表');
});

test('骨架的颜色和 tokens.css 一致', () => {
  equal(boot('.boot', 'background'), token('@theme {', 'color-bg'));
  for (const selector of ['.boot-bar', '.boot-rail', '.boot-status'])
    equal(boot(selector, 'background'), token('@theme {', 'color-bar'), `${selector} 的底色对不上 --color-bar`);

  // 浅色那三块合写成一条规则，所以单独取。
  const light = /html\[data-theme="light"\] \.boot-bar,[\s\S]*?\{([^}]*)\}/.exec(html);
  ok(light, '浅色主题下的三块外壳应当有一条合并规则');
  equal(/background:\s*([^;]+)/.exec(light![1])![1].trim(), token('html[data-theme="light"]', 'color-bar'));
  equal(boot('html[data-theme="light"] .boot', 'background'), token('html[data-theme="light"]', 'color-bg'));
});

test('骨架的尺寸和真外壳一致', () => {
  const topBar = read('../src/app/TopBar.tsx');
  const rail = read('../src/app/LeftRail.tsx');
  // Tailwind 的 h-10 / w-10 是 2.5rem，而 shell.css 把根字号定成 13px —— 40px 是这么来的。
  match(topBar, /className="bar-chrome flex h-10 /, '顶栏不再是 h-10 了，骨架的 40px 要跟着改');
  match(rail, /className="bar-chrome flex w-10 /, '图标栏不再是 w-10 了，骨架的 40px 要跟着改');
  equal(boot('.boot-bar', 'height'), '40px');
  equal(boot('.boot-rail', 'width'), '40px');

  const base = /\.status-bar \{([^}]*)\}/.exec(statusBarCss);
  ok(base, 'statusBar.css 里应当有 .status-bar');
  equal(boot('.boot-status', 'height'), /height:\s*([^;]+)/.exec(base![1])![1].trim());

  const coarse = /@media \(pointer: coarse\) \{ \.status-bar \{([^}]*)\}/.exec(statusBarCss);
  ok(coarse, '触屏下的状态栏高度那条没了？');
  const bootCoarse = /@media \(pointer: coarse\) \{ \.boot-status \{([^}]*)\} \}/.exec(html);
  ok(bootCoarse, '骨架也要有触屏下的状态栏高度');
  equal(/height:\s*([^;]+)/.exec(bootCoarse![1])![1].trim(), /height:\s*([^;]+)/.exec(coarse![1])![1].trim());
});
