// 隔离的浏览器 fixture：把 vendor/dsh 的完整 markdown 渲染树喂一段够狠的正文画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-markdown.html 就行（?theme=light 看浅色）。
//
// 单测钉不住的是这几样：CSS Module 有没有打进来、tokens.css 的 --dsw-font-markdown-* /
// --dsw-alias-markdown-inline-code 有没有接上、KaTeX 的样式表在懒加载之后还到不到位。
// 这三样任何一个断了，画面当场就是没层级的裸 DOM 或者一块没底色的行内代码。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownText } from '../../src/vendor/dsh/markdown/MarkdownText.tsx';
// markdown/ 下的文件不在 vendor/dsh 的桶里，直接 import 不会带上令牌表——真实调用方
// 是从桶（或 chat/AssistantMarkdown）进来的，那条路上 tokens.css 已经在了。
import '../../src/vendor/dsh/tokens.css';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
import '../../src/index.css';

// 截图脚本按 ?theme= 决定深浅；ThemeProvider 从 localStorage 读初值，所以在挂载前写进去。
const forced = new URLSearchParams(location.search).get('theme');
if (forced === 'light' || forced === 'dark') {
  try { localStorage.setItem('roost-theme', forced); } catch { /* 无痕模式，忽略 */ }
}

/* 这段正文是**照着任务清单逐条凑的**，每一行都在钉一种语法。删之前先想清楚它在钉什么。 */
const SOURCE = [
  '# 一级标题：渲染树自检',
  '',
  '这是一段**普通正文**，里面有 *斜体*、**粗体**、`行内代码`，还有一条',
  '[指向上游仓库的链接](https://github.com/deepseek-ai/deepseek-harness)。',
  '',
  '中文与粗体相邻是 `cjkFriendlyStrong` 存在的全部理由：这里**重点**紧贴汉字，',
  '按 CommonMark 原文的规则右侧定界符会因为两边都是标点/汉字而失效，加了那个扩展才成粗体。',
  '对照组（两侧有空格，原版规则也认）：这里 **重点** 分开写。',
  '',
  '## 二级标题：列表',
  '',
  '1. 有序列表第一项',
  '2. 第二项，下面嵌一层无序：',
  '   - 嵌套项甲，带 `code`',
  '   - 嵌套项乙',
  '     1. 再嵌一层有序',
  '     2. 同上',
  '3. 第三项',
  '',
  '- [ ] 任务列表（GFM）未完成',
  '- [x] 已完成的一项',
  '',
  '### 三级标题：表格',
  '',
  '| 语法 | 由谁解析 | 备注 |',
  '| --- | :---: | ---: |',
  '| 表格 | `micromark-extension-gfm` | 右列右对齐 |',
  '| 公式 | `micromark-extension-math` | KaTeX 懒加载 |',
  '| 围栏 | `CodeBlock` + shiki | 同步高亮 |',
  '',
  '#### 四级标题：引用与围栏',
  '',
  '> 引用块第一行，里面也能有**粗体**和 `行内代码`。',
  '>',
  '> > 嵌套的第二层引用。',
  '',
  '```ts',
  'export function parseXyz(content: string) {',
  '  const lines = content.split(/\\r\\n|\\r|\\n/)',
  '  const atoms: Atom[] = []',
  '  for (const line of lines) {',
  '    if (!line.trim()) continue',
  '    const cols = line.split(/\\s+/)',
  '    if (cols.length < 4) continue',
  '    atoms.push({ element: cols[0], x: +cols[1], y: +cols[2], z: +cols[3] })',
  '  }',
  '  return { atoms }',
  '}',
  '```',
  '',
  '```sh',
  'umask 022 && env -u ROOST_CLAUDE_OBSERVING npm test --workspaces --if-present',
  '```',
  '',
  '##### 五级标题：数学',
  '',
  '行内公式 $E = mc^2$ 与 $\\sum_{i=1}^{n} x_i$ 夹在正文里。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\frac{\\partial \\mathcal{L}}{\\partial \\theta}',
  '  = \\mathbb{E}_{x \\sim p(x)}\\left[ \\nabla_\\theta \\log \\pi_\\theta(x) \\, A(x) \\right]',
  '$$',
  '',
  '还有一条矩阵：',
  '',
  '$$',
  '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
  '\\begin{bmatrix} x \\\\ y \\end{bmatrix}',
  '= \\begin{bmatrix} ax + by \\\\ cx + dy \\end{bmatrix}',
  '$$',
  '',
  '---',
  '',
  '脚注也走渲染树[^1]，分割线在它上面。',
  '',
  '[^1]: 脚注正文由 `renderFootnoteSection` 追加在文档末尾。',
].join('\n');

/* 上游这批组件一个字符串都不自带，本地化文案全由调用方给。 */
const LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div style={{ background: 'var(--color-bg)', minHeight: '100vh', padding: '24px 32px 64px' }}>
      <button
        type="button"
        onClick={toggleTheme}
        style={{
          font: 'var(--dsw-font-xs-13)', color: 'var(--color-text)', background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border)', borderRadius: 6, padding: '4px 10px', marginBottom: 20,
        }}
      >
        当前 {theme} —— 点我切换
      </button>
      <div style={{ maxWidth: 760, background: 'var(--color-bg-panel)', borderRadius: 10, padding: '20px 24px' }}>
        <MarkdownText text={SOURCE} labels={LABELS} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
