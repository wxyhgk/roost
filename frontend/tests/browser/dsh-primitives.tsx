// 隔离的浏览器 fixture：把 vendor/dsh 里留下的每块积木用假数据各画一遍。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-primitives.html 就行。
//
// 用途是看三样东西有没有接上——CSS Module 打包、tokens.css 的令牌映射、深色/浅色主题。
// 这三样任何一个断了，画面当场就是白底黑字的裸 DOM 或者一片无色，单测钉不住这个。
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DiffBlock, DisclosureRow, JsonBlock, Pill, SearchBlock,
  StateDot, TerminalBlock, WebBlock, type StateDotState,
} from '../../src/vendor/dsh';
// 吃 shiki 的两块单独一个入口，理由见 vendor/dsh/index.ts 顶上。
import { CodeBlock, ReadBlock } from '../../src/vendor/dsh/highlighted';

import { IconCodeOutline16 } from '../../src/vendor/dsh/icons/index.tsx';
import { ThemeProvider } from '../../src/shared/theme';
import '../../src/index.css';

/* 每块积木的本地化文案都由调用方给（上游这批组件一个字符串都不自带）。 */
const fold = {
  collapseAria: '收起',
  expandAria: (n: number) => `展开其余 ${n} 行`,
  collapse: '收起',
  expand: (n: number) => `… 还有 ${n} 行`,
};
const copy = { copy: '复制', copied: '已复制' };

const OLD_TS = `export function parseXyz(content: string) {
  const lines = content.split(/\\r\\n|\\r|\\n/);
  const atoms: Atom[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // 空行跳过
    const cols = line.split(/\\s+/);
    if (cols.length < 4) continue;
    atoms.push({ element: cols[0], x: +cols[1], y: +cols[2], z: +cols[3] });
  }
  return { atoms };
}`;
const NEW_TS = `export function parseXyz(content: string) {
  const lines = content.split(/\\r\\n|\\r|\\n/);
  const atoms: Atom[] = [];
  for (const line of lines) {
    if (!line.trim()) break;
    const cols = line.split(/\\s+/);
    if (cols.length < 4) continue;
    atoms.push({ element: cols[0], x: +cols[1], y: +cols[2], z: +cols[3] });
  }
  if (atoms.length === 0) throw new Error('xyz: 没有解析出任何原子');
  return { atoms, count: atoms.length };
}`;

/* 真的带 ANSI 转义：绿的 ✔、红的 ✖、暗灰的耗时。颜色是 ansi.ts 解析出来的，不是 CSS 抹上去的。 */
const G = '\u001b[32m', R = '\u001b[31m', D = '\u001b[90m', B = '\u001b[1m', Y = '\u001b[33m', Z = '\u001b[0m';
const TERMINAL_OUTPUT = [
  `${B}> frontend@0.0.8 test${Z}`,
  ...Array.from({ length: 28 }, (_, i) => `${G}✔${Z} 用例 ${i + 1} 通过 ${D}(0.${i}ms)${Z}`),
  `${Y}⚠ 2 个用例被跳过${Z}`,
  `${R}✖ 空行兜底删掉之后，后面的原子跟着消失${Z}`,
  `  ${R}AssertionError: 3 !== 1${Z}`,
  `${B}ℹ fail 1${Z}`,
].join('\n');

const READ_LINES = NEW_TS.split('\n').map((text, i) => ({ number: i + 41, text }));

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 8px' }}>{title}</h2>
      {children}
    </section>
  );
}

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ width: 760, margin: '0 auto', padding: 24, color: 'var(--color-text)' }}>
      <Section title="StateDot —— 五种状态">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {(['done', 'warning', 'ongoing', 'error', 'idle'] as StateDotState[]).map(state => (
            <span key={state} style={{ display: 'flex', gap: 6, alignItems: 'center', font: 'var(--dsw-font-xs-13)' }}>
              <StateDot state={state} />{state}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Pill">
        <div style={{ display: 'flex', gap: 8 }}>
          <Pill>普通</Pill>
          <Pill active>选中</Pill>
          <Pill>exit 1</Pill>
        </div>
      </Section>

      <Section title="DisclosureRow —— 点标题能展开">
        <DisclosureRow
          icon={<IconCodeOutline16 />}
          title="npm test --workspace frontend"
          open={open}
          expandable
          onToggle={() => setOpen(v => !v)}
          collapsedContent={<span style={{ marginLeft: 8, color: 'var(--color-danger)' }}>fail 1</span>}
        >
          <div style={{ font: 'var(--dsw-font-markdown-code-block)', whiteSpace: 'pre-wrap' }}>
            展开之后才出现的内容。收起时这一段不在 DOM 里。
          </div>
        </DisclosureRow>
      </Section>

      <Section title="DiffBlock —— 有增有删，超过 8 行会折叠中间">
        <DiffBlock
          diffs={[{ path: 'frontend/src/plugins/xyz/parse.ts', oldText: OLD_TS, newText: NEW_TS }]}
          maxLines={8}
          labels={{ ...copy, ...fold, files: n => `${n} 个文件` }}
        />
      </Section>

      <Section title="DiffBlock —— 新建文件（oldText 为 null）">
        <DiffBlock
          diffs={[{ path: 'frontend/tests/xyz-parse.test.ts', oldText: null, newText: "import { test } from 'node:test';\ntest('空行截断', () => {});\n" }]}
          labels={{ ...copy, ...fold, files: n => `${n} 个文件` }}
        />
      </Section>

      <Section title="TerminalBlock —— ANSI 颜色 + 退出码 + 折叠">
        <TerminalBlock
          command="npm test --workspace frontend"
          cwd="/Users/me/roost"
          home="/Users/me"
          output={TERMINAL_OUTPUT}
          exitCode={1}
          maxLines={10}
          labels={{
            ...copy, ...fold,
            signal: s => `信号 ${s}`,
            exitCode: c => `退出码 ${c}`,
            running: '运行中',
            failed: '失败',
            done: '完成',
            noOutput: '没有输出',
          }}
        />
      </Section>

      <Section title="TerminalBlock —— 运行中，还没有输出">
        <TerminalBlock
          command="npm run dev --prefix frontend"
          running
          labels={{
            ...copy, ...fold,
            signal: s => `信号 ${s}`,
            exitCode: c => `退出码 ${c}`,
            running: '运行中',
            failed: '失败',
            done: '完成',
            noOutput: '没有输出',
          }}
        />
      </Section>

      <Section title="ReadBlock —— 行号 + 语法高亮（shiki）">
        <ReadBlock
          label="frontend/src/plugins/xyz/parse.ts"
          lines={READ_LINES}
          totalLines={186}
          lang="typescript"
          maxLines={8}
          labels={{ ...copy, ...fold, window: (shown, total) => `${shown} / ${total} 行` }}
        />
      </Section>

      <Section title="SearchBlock —— 按文件分组的匹配行">
        <SearchBlock
          kind="matches"
          total={5}
          truncated={false}
          files={[
            { path: 'frontend/src/plugins/xyz/parse.ts', matches: [
              { lineNumber: 41, line: 'export function parseXyz(content: string) {' },
              { lineNumber: 52, line: '  return { atoms, count: atoms.length };' },
            ] },
            // 这几行是**假的搜索结果数据**，不是 import。别写成 `... from '<路径>'` 的形状：
            // scripts/check-boundaries.mjs 用启发式正则抽 import，会把它当成一条指向
            // 不存在文件的引用，直接判红（AGENTS.md 第四节写着这件事）。
            { path: 'frontend/tests/xyz-parse.test.ts', matches: [
              { lineNumber: 3, line: "const parsed = parseXyz(readFileSync(sample, 'utf8'));" },
              { lineNumber: 9, line: "  assert.equal(parseXyz(sample).atoms.length, 3);" },
              { lineNumber: 14, line: "  assert.throws(() => parseXyz(''));" },
            ] },
          ]}
          labels={{
            ...copy,
            pathsSummary: (shown, total) => `${shown} / ${total} 个文件`,
            matchesSummary: (shown, total, files) => `${shown} / ${total} 处匹配，${files} 个文件`,
            noResults: '没有匹配',
            ...fold,
          }}
        />
      </Section>

      <Section title="SearchBlock —— 只有路径，且被截断">
        <SearchBlock
          kind="paths"
          total={42}
          truncated
          maxLines={6}
          paths={Array.from({ length: 12 }, (_, i) => `frontend/src/features/conversations/tools/Tool${i + 1}.tsx`)}
          labels={{
            ...copy,
            pathsSummary: (shown, total, truncated) => `${shown} / ${total} 个文件${truncated ? '（已截断）' : ''}`,
            matchesSummary: (shown, total, files) => `${shown} / ${total} 处匹配，${files} 个文件`,
            noResults: '没有匹配',
            ...fold,
          }}
        />
      </Section>

      <Section title="CodeBlock —— 带头条和行号">
        <CodeBlock
          code={"const hunk = (lines: string[]) => ({\n  oldStart: 12,\n  newStart: 12,\n  lines,\n});\n// 注释也要有颜色\nexport default hunk;"}
          lang="typescript"
          lineNumbers
          showHeader
          copyLabel="复制"
          copiedLabel="已复制"
        />
      </Section>

      <Section title="JsonBlock —— 点标题展开">
        <JsonBlock
          label="tool_call 参数"
          payload={{ file_path: '/Users/me/roost/frontend/src/plugins/xyz/parse.ts', offset: 40, limit: 60, nested: { a: [1, 2, 3], b: null } }}
          truncatedLabel={total => `（共 ${total} 字，已截断）`}
        />
      </Section>

      <Section title="WebBlock —— web_search">
        <WebBlock
          kind="search"
          answer={'xyz 文件格式的第一行是原子数，第二行是注释，其后每行一个原子。\n空行不是终止符，解析器不该拿它当边界。'}
          sources={[
            { url: 'https://en.wikipedia.org/wiki/XYZ_file_format', title: 'XYZ file format', snippet: 'The XYZ file format is a chemical file format…', publishedAt: '2026-03-02' },
            { url: 'https://openbabel.org/docs/FileFormats/XYZ_cartesian_coordinates_format.html', snippet: 'Open Babel 对 xyz 的宽松解析实现。' },
          ]}
          truncated
          labels={{
            noResults: '没有结果',
            sourcesTruncated: '来源已截断',
            http: 'HTTP',
            contentTruncated: '内容已截断',
            markdown: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' },
          }}
        />
      </Section>

      <Section title="WebBlock —— web_fetch">
        <WebBlock
          kind="fetch"
          url="https://openbabel.org/docs/FileFormats/XYZ_cartesian_coordinates_format.html"
          statusCode={200}
          truncated
          labels={{
            noResults: '没有结果',
            sourcesTruncated: '来源已截断',
            http: 'HTTP',
            contentTruncated: '内容已截断',
            markdown: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' },
          }}
        />
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
