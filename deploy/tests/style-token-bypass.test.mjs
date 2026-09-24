/*
  `scripts/check-boundaries.mjs` 里「语义令牌被绕过」那条检查的纯逻辑。

  **为什么测的是纯函数而不是整条检查**：整条检查要扫全仓库，它今天绿只说明「今天没人犯」，
  说明不了「犯了会红」。而这条检查真正的风险不是漏报，是**误报**——一误报就有人来加豁免，
  加几条它就废了。所以下面一半的用例是在钉「这些东西不许报」：注释里的字样、内描边高光、
  仪表数字、CPK 色、token 的定义处。

  测试文件放在 deploy/tests/ 是照 install-service.test.mjs 的旧例：`npm run verify` 里那句
  `node --test deploy/tests/*.test.mjs` 会连它一起跑，不用动 package.json。
*/
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { blankComments, canonicalColor, designTokenColors, styleTokenBypasses } from '../../scripts/check-boundaries.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const messages = (rel, text, tokens) => styleTokenBypasses(rel, text, tokens).map(f => f.message);

/*
  **import 这个文件不许把整个进程判红。**

  check-boundaries.mjs 的检查全在顶层跑，早先它无条件地 `process.exitCode = 1`。测试一旦
  import 它，仓库里只要有任何一条边界问题，这个测试进程就会在「全部用例通过」之后仍然
  退出码 1——而那种红最难查，因为没有任何一条用例失败。
*/
test('被 import 时不设退出码', () => {
  assert.ok(!process.exitCode, `import check-boundaries.mjs 之后 exitCode 成了 ${process.exitCode}`);
});

/*
  上面那条只在仓库**本来就有边界问题**时才会红，绿的时候证明不了什么。这条补上另一半：
  被 import 的时候它一个字都不该往 stdout 写。守卫一没，这里立刻变成
  "Workspace source boundaries passed"。
*/
test('被 import 时一声不吭', async () => {
  const script = `await import(${JSON.stringify(resolve(root, 'scripts/check-boundaries.mjs'))});`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(stdout, '', 'import 时不该有输出——顶层的汇报没有被「只在直接执行时」的守卫拦住');
});

/* ---- 注释：这条检查最容易误伤的地方，就是记录这几次事故的那几段注释本身 ---- */

test('块注释里的字样不算命中', () => {
  const css = `/* 阴影原来是写死的 box-shadow: 0 8px 32px #0003，绕过了 --shadow-pop，和那三个 shadow-2xl 是同一类问题 */\n.a { box-shadow: var(--shadow-pop); }\n`;
  assert.deepEqual(messages('frontend/src/a.css', css), []);
  const tsx = `/*\n  这个对话框原来是 14/12（Tailwind 默认的 text-sm/text-xs），阴影用的是 shadow-2xl。\n*/\nexport const cls = 'shadow-pop text-body';\n`;
  assert.deepEqual(messages('frontend/src/a.tsx', tsx), []);
});

test('行注释里的字样不算命中，但 https:// 不是行注释', () => {
  assert.deepEqual(messages('frontend/src/a.ts', `const c = 'shadow-pop'; // 原来是 shadow-lg\n`), []);
  // `//` 前面是冒号时不当注释：否则整行被挖空，同一行上真正的违规就静默漏掉了。
  const withUrl = messages('frontend/src/a.ts', `const doc = 'https://example.com/x'; const c = 'shadow-2xl';\n`);
  assert.equal(withUrl.length, 1);
  assert.match(withUrl[0], /shadow-2xl/);
});

test('挖注释要保住行号', () => {
  const text = `/* 第一行\n第二行\n第三行 */\nconst c = 'shadow-2xl';\n`;
  assert.deepEqual(styleTokenBypasses('frontend/src/a.ts', text).map(f => f.line), [4]);
  assert.equal(blankComments('/* ab */\nx\n').split('\n').length, 3);
  assert.equal(blankComments('/* ab */x').trimEnd(), '        x'.trimEnd());
});

test('CSS 不认行注释：url(http://…) 不该被当成注释挖掉', () => {
  const css = `.a { background: url(http://example.com/a.png); box-shadow: 0 2px 4px #0a84ff; }\n`;
  assert.equal(messages('frontend/src/a.css', css).length, 1);
});

/* ---- 一、Tailwind 默认阴影档 ---- */

test('默认阴影档一律报，语义令牌不报', () => {
  for (const cls of ['shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-inner']) {
    const out = messages('frontend/src/a.tsx', `<div className="${cls}" />`);
    assert.equal(out.length, 1, `${cls} 应该报一条`);
    assert.match(out[0], /shadow-pop|shadow-modal/);
  }
  assert.deepEqual(messages('frontend/src/a.tsx', `<div className="shadow-pop" />`), []);
  assert.deepEqual(messages('frontend/src/a.tsx', `<div className="shadow-modal" />`), []);
});

test('.ts 里拼出来的 className 一样要查——当初漏掉 fileLinkProvider 就是因为只搜了 .tsx', () => {
  const ts = `hint.className = 'xterm-hover rounded border border-border bg-bg-panel shadow-lg break-words';\n`;
  assert.equal(messages('frontend/src/features/terminal/engine/fileLinkProvider.ts', ts).length, 1);
});

test('任意值阴影：inset 是高光不是投影，放行；带偏移的投影照报', () => {
  assert.deepEqual(messages('frontend/src/a.tsx', `<div className="shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" />`), []);
  const out = messages('frontend/src/a.tsx', `<div className="shadow-[0_2px_8px_rgba(0,0,0,0.3)]" />`);
  assert.equal(out.length, 1);
  assert.match(out[0], /不是投影/);
});

/* ---- 二、CSS 里的 box-shadow ---- */

test('box-shadow：var(--shadow-*) 与内描边放行', () => {
  const css = [
    '.pop { box-shadow: var(--shadow-pop); }',
    '.modal { box-shadow: var(--shadow-modal); }',
    '.raised { box-shadow: inset 0 0 0 0.7px var(--color-rim); }',
    '.row-rest { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent); }',
    '.off { box-shadow: none; }',
  ].join('\n');
  assert.deepEqual(messages('frontend/src/styles/utilities.css', css), []);
});

test('box-shadow：写死的投影要报，报的是那一层', () => {
  // 这一行是 subscriptions.css 出事时的原文。
  const out = messages('frontend/src/a.css', `.pop { box-shadow: 0 8px 32px #0003; }\n`);
  assert.equal(out.length, 1);
  assert.match(out[0], /0 8px 32px #0003/);
});

test('box-shadow：内描边和投影混写时，只报投影那一层', () => {
  const css = `.pop { box-shadow: inset 0 0 0 0.7px var(--color-rim), 0 12px 32px rgba(0, 0, 0, 0.36); }\n`;
  const out = messages('frontend/src/a.css', css);
  assert.equal(out.length, 1, '内描边那层不该被算进去');
  assert.match(out[0], /0 12px 32px/);
});

test('box-shadow 里 rgba 的逗号不是分层符', () => {
  const out = messages('frontend/src/a.css', `.a { box-shadow: 0 1px 2px rgba(1, 2, 3, 0.4); }\n`);
  assert.equal(out.length, 1, 'rgba 里的逗号被当成分层符的话会报出三条残句');
});

/* ---- 三、Tailwind 默认字号档 ---- */

test('默认字号档要报，三个语义令牌和另一根轴上的不报', () => {
  for (const cls of ['text-xs', 'text-sm', 'text-base']) {
    const out = messages('frontend/src/a.tsx', `<p className="${cls}" />`);
    assert.equal(out.length, 1, `${cls} 应该报一条`);
    assert.match(out[0], /text-caption|text-body|text-title/);
  }
  // 仪表数字、9/10/12.5px 的角标与代码块、以及颜色类，都不在这条判据的形状里。
  for (const cls of ['text-caption', 'text-body', 'text-title', 'text-lg', 'text-3xl', 'text-[9px]', 'text-[12.5px]', 'text-text-dim'])
    assert.deepEqual(messages('frontend/src/a.tsx', `<p className="${cls}" />`), [], `${cls} 不该报`);
});

/* ---- 四、字面颜色的值等于某个令牌的值 ---- */

const TOKENS = designTokenColors([
  '@theme {',
  '  --color-accent: #0a84ff;',
  '  --color-border: rgba(255, 255, 255, 0.10);',
  '  --color-bar-hover: rgba(255, 255, 255, 0.1);',
  '  --color-bar-text: #ffffff;',
  '  --color-text: #f5f5f7;',
  '  --terminal-bg: #111113;',
  '  --text-body: 13px;',
  '  --surface-raised: linear-gradient(160deg, #333337, #262629);',
  '}',
].join('\n'));

test('令牌表：只收 --color-*，同值的多个名字并成一条', () => {
  assert.equal(TOKENS.get(canonicalColor('#0a84ff')).size, 1);
  assert.deepEqual([...TOKENS.get(canonicalColor('rgba(255,255,255,0.1)'))].sort(), ['--color-bar-hover', '--color-border']);
  assert.equal(TOKENS.has(canonicalColor('#333337')), false, '渐变里的色标不是颜色令牌');
  /*
    `--terminal-*` 是**另一根轴**：16 色 ANSI 调色板和这套界面语义色没有从属关系，
    终端配色换一套的时候它们本来就该各走各的。收进来的话，凡是撞上终端底色的字面值都会
    被报成「这就是 --terminal-bg」——那是个更弱、也更容易被反驳的说法，说服力一低，
    整条判据就开始被人加豁免。所以只认 `--color-*`。
  */
  assert.equal(TOKENS.has(canonicalColor('#111113')), false, '只认 --color-*，别的前缀不算语义色令牌');
});

test('令牌表不读注释里的字样', () => {
  const parsed = designTokenColors('/* 分隔线原来是 --color-border: #3a3a3e; 现在改了 */\n--color-bg: #111113;\n');
  assert.equal(parsed.has(canonicalColor('#3a3a3e')), false);
  assert.equal(parsed.has(canonicalColor('#111113')), true);
});

test('字面颜色撞上令牌值就报，换个写法也躲不掉', () => {
  for (const literal of ['#0a84ff', '#0A84FF', 'rgb(10, 132, 255)', 'rgba(10,132,255,1)']) {
    const out = messages('frontend/src/a.css', `.a { color: ${literal}; }\n`, TOKENS);
    assert.equal(out.length, 1, `${literal} 应该报一条`);
    assert.match(out[0], /--color-accent/);
  }
  assert.deepEqual(messages('frontend/src/a.css', '.a { color: #0b85ff; }\n', TOKENS), [], '不等于任何令牌值的就不报');
});

test('令牌的定义处不报——那儿本来就该写字面值', () => {
  // 终端 16 色调色板、server-monitor 的局部配色，都是在定义另一根轴上的 token。
  const css = `html[data-terminal-theme="dark"] {\n  --terminal-bg: #f5f5f7;\n  --terminal-fg: #0a84ff;\n}\n`;
  assert.deepEqual(messages('frontend/src/styles/terminal.css', css, TOKENS), []);
});

test('纯黑纯白不报：CPK 里的氢是白的，读不到变量时的兜底是黑的', () => {
  assert.deepEqual(messages('frontend/src/shared/chemistry/elements.ts', `const cpk = { H: '#ffffff' };\n`, TOKENS), []);
  assert.deepEqual(messages('frontend/src/plugins/xyz/xyz.tsx', `return getProperty('--color-bg').trim() || "#000000";\n`, TOKENS), []);
});

/* ---- 判据挂在 tokens.css 上，所以拿真文件再钉一遍 ---- */

test('真的 tokens.css 解析得出来（解析方式和文件写法对不上就会静默失效）', () => {
  const css = readFileSync(resolve(root, 'frontend/src/styles/tokens.css'), 'utf8');
  const tokens = designTokenColors(css);
  assert.ok(tokens.size >= 20, `只解析出 ${tokens.size} 个颜色令牌`);
  assert.deepEqual([...tokens.get(canonicalColor('#0a84ff'))], ['--color-accent']);
  for (const token of ['--shadow-pop', '--shadow-modal'])
    assert.match(css, new RegExp(`${token}\\s*:`), `${token} 不见了，报错信息会指向一个不存在的令牌`);
});

test('整条检查在当前仓库上干净通过', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve(root, 'scripts/check-boundaries.mjs')]);
  assert.match(stdout, /Workspace source boundaries passed/);
});

/* ---- 颜色归一 ---- */

test('颜色归一：同一个颜色的各种写法归到一起', () => {
  assert.equal(canonicalColor('#fff'), canonicalColor('#ffffff'));
  assert.equal(canonicalColor('#fff'), canonicalColor('rgb(255, 255, 255)'));
  assert.equal(canonicalColor('  #0A84FF '), canonicalColor('#0a84ff'));
  assert.equal(canonicalColor('rgba(255,255,255,.1)'), canonicalColor('rgba(255, 255, 255, 0.10)'));
  assert.equal(canonicalColor('#ff000080'), '255,0,0,0.5019607843137255');
  // 四位形态：`box-shadow: 0 8px 32px #0003` 出事时写的就是它。
  assert.equal(canonicalColor('#0003'), canonicalColor('#00000033'));
  assert.notEqual(canonicalColor('#0a84ff'), canonicalColor('#0a84fe'));
});

test('颜色归一：认不出来的返回 null，不许乱猜', () => {
  for (const bad of ['', 'red', 'var(--color-accent)', '#12345', 'rgb(100%, 0%, 0%)', 'rgb(1,2)', 'color-mix(in srgb, red, blue)', '13px'])
    assert.equal(canonicalColor(bad), null, `${bad} 不该被当成颜色`);
});
