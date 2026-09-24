/*
  build-diff 的纯逻辑部分。

  这里**不构建任何东西**——构建那半截要一分钟，没法当单元测试跑。能测的、也最值得测的，
  是「怎么把产物切成可比的单位」：切错了的后果不是报错，而是**差异被切没了**，于是脚本
  安静地说「一致」，和它本来要抓的那个毛病一模一样。

  跑法（仓库约定的环境）：
    umask 022 && env -u ROOST_CLAUDE_OBSERVING node --import tsx --test scripts/tests/build-diff.test.mjs
*/
import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { diffMultiset, hashedRefs, splitCssRules, splitHtmlTags, stripHash } from '../build-diff.mjs';

test('相邻的规则各算一条', () => {
  deepEqual(splitCssRules('.a{color:red}.b{color:blue}'), ['.a{color:red}', '.b{color:blue}']);
});

test('@media 下钻，上下文拼在规则前面', () => {
  /*
    不下钻的话，@media 块整体是一条规则：里面改一个像素值，报出来的是一条几千字符的差异，
    等于什么都没说。下钻之后差异落在具体那条规则上。
  */
  deepEqual(splitCssRules('@media (min-width:640px){.a{color:red}.b{color:blue}}'), [
    '@media (min-width:640px) › .a{color:red}',
    '@media (min-width:640px) › .b{color:blue}',
  ]);
});

test('@layer 套 @media 套规则，上下文按层叠起来', () => {
  deepEqual(splitCssRules('@layer base{@media print{.a{color:red}}}'), ['@layer base › @media print › .a{color:red}']);
});

test('声明块不下钻，顺序原样留在规则文本里', () => {
  /*
    CSS 里后面的声明覆盖前面的，所以顺序是有意义的。把声明拆成集合的话，
    `color:red;color:blue` 和 `color:blue;color:red` 会被判成一样——那是两种不同的渲染。
  */
  const [one] = splitCssRules('.a{color:red;color:blue}');
  const [two] = splitCssRules('.a{color:blue;color:red}');
  equal(one, '.a{color:red;color:blue}');
  ok(one !== two);
});

test('没有块体的 at-rule 自成一条', () => {
  deepEqual(splitCssRules('@charset "utf-8";.a{color:red}'), ['@charset "utf-8";', '.a{color:red}']);
});

test('字符串里的花括号和分号不算分隔符', () => {
  /*
    `content` 里放 `}` 是真事（伪元素画括号）。按字符数花括号的话，这里会在 `}` 处提前收口，
    后面整份样式表都跟着错位——而错位的结果是两边都错位，报告看起来还挺正常。
  */
  deepEqual(splitCssRules('.a::after{content:"};{"}.b{color:red}'), ['.a::after{content:"};{"}', '.b{color:red}']);
});

test('不带引号的 url() 里的分号不切开声明', () => {
  // data URI 里的 `;base64,` 是最常见的一处：按分号切会把一条 background 劈成两条假规则
  deepEqual(splitCssRules('.a{background:url(data:image/svg+xml;base64,AAA=) no-repeat}'), [
    '.a{background:url(data:image/svg+xml;base64,AAA=) no-repeat}',
  ]);
  /*
    上面那条其实杀不掉「不认 url()」的写法：纯声明块不下钻，切错了也拼不回去。
    真正会露馅的是**嵌套**——块体里同时有声明和子规则时要逐条切，这时 data URI 里的分号
    会凭空多切出一条假规则，于是同一份 CSS 在两边被切成不同条数，报告里出现根本不存在的差异。
    （变异测试里「url() 不特殊处理」这个变异就是靠这一条才被杀掉的。）
  */
  deepEqual(splitCssRules('.a{background:url(data:image/svg+xml;base64,AAA=);&:hover{color:red}}'), [
    '.a › background:url(data:image/svg+xml;base64,AAA=);',
    '.a › &:hover{color:red}',
  ]);
});

test('注释去掉，空白压成一个空格', () => {
  deepEqual(splitCssRules('.a\n , .b /* 说明 */ {\n  color : red ;\n}'), ['.a , .b{color : red ;}']);
});

test('字体路径没被 Vite 解析时，@font-face 变成另一条规则', () => {
  /*
    这就是这个脚本存在的那次事故：index.css 拆进 src/styles/ 之后 `url("./fonts/…")`
    解析不到，Vite 把字面路径原样写进产物，线上四个字体 404 且不报错。
    产物里这两条必须是**不同**的规则，否则脚本会说「一致」。
  */
  const broken = splitCssRules('@font-face{font-family:"IBM Plex Mono";src:url("./fonts/ibm-plex-mono-400-latin.woff2") format("woff2")}');
  const fixed = splitCssRules('@font-face{font-family:"IBM Plex Mono";src:url(/assets/ibm-plex-mono-400-latin-DaBcEfGh.woff2) format("woff2")}');
  equal(broken.length, 1);
  equal(fixed.length, 1);
  ok(broken[0] !== fixed[0]);
  const { onlyLeft, onlyRight } = diffMultiset(fixed, broken);
  equal(onlyLeft.length, 1);
  equal(onlyRight.length, 1);
});

test('剥掉 Rollup 的内容哈希，包里自带的那截不动', () => {
  equal(stripHash('main-DfdKH8bj.js'), 'main.js');
  equal(stripHash('KaTeX_AMS-Regular-BQhdFMY1.woff2'), 'KaTeX_AMS-Regular.woff2');
  equal(stripHash('index.modern-55d8e3ef-rS4gIdjN.js'), 'index.modern-55d8e3ef.js');
  equal(stripHash('index.html'), 'index.html');
  equal(stripHash('favicon.svg'), 'favicon.svg');
});

test('从 chunk 代码里捞跨 chunk 引用，并剥掉哈希', () => {
  const code = 'import("./FilesView-BDb5_unz.js");const u="/assets/ibm-plex-mono-400-latin-Bxy12_ab.woff2";';
  deepEqual(hashedRefs(code), ['FilesView.js', 'ibm-plex-mono-400-latin.woff2']);
});

test('多重集合按出现次数比，不是按去重后的集合比', () => {
  /*
    同一条规则出现两次和出现一次是两回事（压缩器把重复规则合掉了，或者反过来多出一份）。
    去重会把这种变化吃掉。
  */
  const { onlyLeft, onlyRight } = diffMultiset(['a', 'a', 'b'], ['a', 'c']);
  deepEqual(onlyLeft.sort(), ['a', 'b']);
  deepEqual(onlyRight, ['c']);
});

test('入口 HTML 按标签切，并剥掉资产哈希', () => {
  const before = splitHtmlTags('<html><head><script src="/assets/main-AAAAAAAA.js"></script></head></html>');
  const after = splitHtmlTags('<html><head><script src="/assets/main-BBBBBBBB.js"></script></head></html>');
  deepEqual(before, after);
  ok(before.includes('<script src="/assets/main.js">'));
});

test('入口 HTML 少了一个标签要报出来', () => {
  const before = splitHtmlTags('<html><head><link rel="stylesheet" href="/assets/main-AAAAAAAA.css"><title>x</title></head></html>');
  const after = splitHtmlTags('<html><head><title>x</title></head></html>');
  const { onlyLeft, onlyRight } = diffMultiset(before, after);
  deepEqual(onlyLeft, ['<link rel="stylesheet" href="/assets/main.css">']);
  deepEqual(onlyRight, []);
});
