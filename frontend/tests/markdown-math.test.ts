/*
  Markdown 里的数学公式。

  这里钉两件事，而**第二件比第一件重要**：哪些该渲染成公式，以及**哪些绝不能**。
  这个仓库的文档和 AI 回复里全是 shell，而 `$` 既是行内公式的分隔符、又是变量前缀——
  一旦规则放宽，坏的不是公式，是所有现成的文档。

  ## 一次量错的记录

  最初扫 .md 原文，数到 4 处形如 `--run "$sender_conversation_id" --request-id "$` 的
  片段会被行内数学规则吃掉，据此判定单 `$` 不能开。复查才发现**那 4 处全在代码围栏里**
  ——markdown-it 从不对围栏内容套行内规则，散文里真正会被误吃的是 **0 处**。

  教训：**原始文本里的匹配数不等于渲染时的风险**，中间隔着 markdown 自己的结构规则。
  所以下面「不该当公式」那一组里，围栏和行内代码是重点。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { MATH_PENDING, renderMarkdown } from '../src/shared/markdown';

/*
  **同步这一步只认出公式，不渲染它。** 渲染要 katex（365 KB / gzip 119），而绝大多数对话
  里一个公式都没有——所以它改成了按需加载：这里出一个占位 span，挂载后由 `useMathRender`
  决定要不要去取。判据也跟着从「有没有 katex 类名」变成「有没有占位」。
*/
const renderedAsMath = (source: string) =>
  new RegExp(`class="${MATH_PENDING}"`).test(renderMarkdown(source));

test('五种写法都渲染成公式', () => {
  // `$…$` 和 `$$…$$` 是最常见的；`\(…\)` `\[…\]` 是 LLM 也会吐的另一套，
  // 而且它们在接 KaTeX 之前是**被破坏**的——markdown 把反斜杠当转义吃掉了。
  assert.ok(renderedAsMath('质能方程 $E = mc^2$ 如上'), '行内 $');
  assert.ok(renderedAsMath('$$\n\\int_0^1 x^2 dx\n$$'), '行间 $$');
  assert.ok(renderedAsMath('勾股 \\(a^2+b^2=c^2\\) 定理'), '行内 \\( \\)');
  assert.ok(renderedAsMath('\\[ x = \\frac{-b}{2a} \\]'), '行间 \\[ \\]');
  // ```math 是 GitHub 的写法，零歧义，值得一并支持。
  assert.ok(renderedAsMath('```math\n\\sum_{i=1}^n i\n```'), 'math 围栏');
});

test('中文夹着的行内公式也要认', () => {
  // 中文和公式之间没有空格是常态，别让分隔符判定被这个绊住。
  assert.ok(renderedAsMath('所以 $\\alpha$ 是角度'));
  assert.ok(renderedAsMath('当 $n \\to \\infty$ 时收敛'));
});

test('代码里的 $ 绝不能被当成公式——这是本仓库最大的一类误伤', () => {
  // 围栏：实测里那 4 处「危险片段」全在这儿，也正因如此它们其实无害。
  assert.ok(!renderedAsMath('```sh\nfoo --run "$a" --id "$b"\n```'), '围栏代码块');
  // 行内代码：同一件事的另一种写法。
  assert.ok(!renderedAsMath('用 `--run "$a" --id "$b"` 跑'), '行内代码');
  // 缩进代码块也是代码。
  assert.ok(!renderedAsMath('    export A="$x" B="$y"'), '缩进代码块');
});

test('散文里的美元和变量不是公式', () => {
  assert.ok(!renderedAsMath('这个要 $20 和 $30'), '价格');
  assert.ok(!renderedAsMath('设置 $HOME 然后跑'), '单个变量');
  assert.ok(!renderedAsMath('字面量 \\$x\\$ 不是公式'), '转义的 $');
});

test('占位里带着原样的 TeX 和行内/行间的区别', () => {
  /*
    挂载之后要靠这两样把公式还原出来：正文从占位的**文本内容**里读（放属性里要多一层转义），
    行间公式额外带一个标记。丢了任何一样，渲染出来的就不是原来那个公式。
  */
  const inline = renderMarkdown('质能方程 $E = mc^2$ 如上');
  assert.match(inline, /E = mc\^2/, 'TeX 原文要原样留在占位里');
  assert.doesNotMatch(inline, /data-display/, '行内公式不该被标成行间');
  assert.match(renderMarkdown('$$\n\\int_0^1 x\n$$'), /data-display="1"/, '行间公式要标出来');
});

test('写坏的公式只染红自己，不炸掉整篇', () => {
  /*
    `throwOnError: false` 的意义：内容的失败不该毁掉容器。这和 `html: false` 是同一条
    纪律——一段坏东西最多让自己难看，不能把整个面板搞乱。
  */
  const html = renderMarkdown('前面正常 $\\frac{1}{$ 后面还在');
  assert.ok(html.includes('后面还在'), '后面的正文必须还在');
  assert.doesNotThrow(() => renderMarkdown('$\\begin{matrix} 没闭合'));
});

test('公式渲染不影响其余 markdown', () => {
  const html = renderMarkdown('# 标题\n\n段落 $x$ 里有公式\n\n- 列表项\n\n```js\nconst a = 1;\n```');
  assert.ok(html.includes('<h1>'), '标题');
  assert.ok(html.includes('<li>'), '列表');
  assert.ok(html.includes('<code'), '代码块');
  assert.ok(new RegExp(`class="${MATH_PENDING}"`).test(html), '公式');
});

/*
  公式的渲染和样式现在都在 `useMathRender` 里按需取，所以配对关系变了：
  **谁用 renderMarkdown，谁就必须调 useMathRender**。少调一次的后果是公式永远停在占位状态
  ——页面上显示的是一段裸 TeX 原文，而且没有任何报错。

  这条用例扫源码。它守的是同一件事，只是守在新的那一头：以前守「别忘了 import CSS」，
  现在守「别忘了挂 hook」。**下一个消费者一定会忘**，所以这条不能删。
*/
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

test('凡是用 renderMarkdown 的地方，都要挂 useMathRender', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) files.push(path);
    }
  };
  walk(root);

  const consumers = files.filter(path => {
    if (path.endsWith('shared/markdown.ts')) return false;
    return /\brenderMarkdown\b/.test(readFileSync(path, 'utf8'));
  });
  assert.ok(consumers.length >= 2, '至少有文件预览和对话两个消费者，扫不到说明这条用例本身失效了');

  for (const path of consumers) {
    assert.match(readFileSync(path, 'utf8'), /\buseMathRender\b/,
      `${path.slice(root.length)} 用了 renderMarkdown 却没挂 useMathRender——公式会一直停在占位上`);
  }
});

test('katex 和它的样式都只在需要时才取', () => {
  /*
    **同步 import 一条都不许有。** 只要有一条，整个 katex（365 KB / gzip 119）就会跟着
    对话面板一起下——而这正是这次改动要去掉的东西。
  */
  const source = readFileSync(new URL('../src/shared/markdown.ts', import.meta.url).pathname, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+[^\n]*["\']katex/m, 'katex 不许静态 import');
  assert.match(source, /import\(\s*["\']katex["\']\s*\)/, '要在用到的时候动态取');
  assert.match(source, /import\(\s*["\']katex\/dist\/katex\.min\.css["\']\s*\)/, '样式也要动态取，它和渲染结果是配对的');
});
