// 隔离的浏览器 fixture：把 vendor/dsh/chat/tool/toolviews 里那四个工具视图用假数据各画几种。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-toolviews.html 就行（?theme=light 看浅色）。
//
// 和 dsh-primitives.html 同一个用途：看 CSS Module 打包、tokens.css 的令牌映射、深浅两套
// 主题这三样有没有接上。这一页尤其要盯两件 typecheck 和单测都看不见、只有画出来才发现的事
// （NOTICE.md 把它记成了「模式」）：Tailwind 的 preflight 把 `svg` 设成 display:block
// （行内图标会被挤成独立一行），又把 `ol/ul` 的标记清零。
//
// 注意：ToolRow 那个外壳由另一路 agent 在写。这一页的 `labels` 是按上游 ToolRowProps 的
// 形状给的（`t` 换成平的对象）；外壳落地后如果 props 有出入，改的是这里和四个视图的入口，
// 渲染结构不受影响。
import { StrictMode, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { FileMutationRow } from '../../src/vendor/dsh/chat/tool/toolviews/file-mutation-row.tsx';
import { BashRow } from '../../src/vendor/dsh/chat/tool/toolviews/bash-sample.tsx';
import { ReadRow } from '../../src/vendor/dsh/chat/tool/toolviews/read-row.tsx';
import { GenericToolCard } from '../../src/vendor/dsh/chat/tool/toolviews/GenericToolCard.tsx';
// 上面那几行是**直接喂手写 props**，验的是组件本身。下面这一节走我们自己的分派和折算，
// 验的是「真实 transcript 的数据形状能不能喂出这些 props」——两件不同的事，都要看。
import { ToolView } from '../../src/features/conversations/tools/registry.tsx';
// chat/ 下的文件不在 vendor/dsh 的桶里，直接 import 不会带上令牌表。这里显式引一次。
import '../../src/vendor/dsh/tokens.css';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
import '../../src/index.css';

const fold = {
  collapseAria: '收起',
  expandAria: (n: number) => `展开其余 ${n} 行`,
  collapse: '收起',
  expand: (n: number) => `… 还有 ${n} 行`,
};
const copy = { copy: '复制', copied: '已复制' };

/* ToolRow 要的一整套文案（上游是 12 个 t(key)，这里是平的对象）。 */
const ROW_LABELS = {
  running: '运行中',
  failed: '失败',
  stopped: '已中止',
  input: '参数',
  output: '输出',
  inspect: '定位',
  diff: { ...copy, ...fold, files: (n: number) => `${n} 个文件` },
  read: { ...copy, ...fold, window: (shown: number, total: number) => `${shown} / ${total} 行` },
};

/* TerminalBlock 自己那 12 个。 */
const TERMINAL_LABELS = {
  ...copy, ...fold,
  signal: (s: string) => `信号 ${s}`,
  exitCode: (c: number) => `退出码 ${c}`,
  running: '运行中',
  failed: '失败',
  done: '完成',
  noOutput: '没有输出',
};

const BASH_LABELS = {
  running: '运行中', failed: '失败', stopped: '已中止',
  input: '参数', output: '输出', inspect: '定位',
  terminal: TERMINAL_LABELS,
};

const OLD_TS = `export function parseXyz(content: string) {
  const lines = content.split(/\\r\\n|\\r|\\n/);
  const atoms: Atom[] = [];
  for (const line of lines) {
    if (!line.trim()) break;
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
    if (!line.trim()) continue;
    const cols = line.split(/\\s+/);
    if (cols.length < 4) continue;
    atoms.push({ element: cols[0], x: +cols[1], y: +cols[2], z: +cols[3] });
  }
  if (atoms.length === 0) throw new Error('xyz: 没有解析出任何原子');
  return { atoms, count: atoms.length };
}`;

/* 真的带 ANSI 转义：颜色由 shared/terminal-text/ansi.ts 解析，不是 CSS 抹上去的。 */
const G = '[32m', R = '[31m', D = '[90m', B = '[1m', Y = '[33m', Z = '[0m';
const BASH_OK_OUTPUT = [
  `${B}> frontend@0.0.8 test${Z}`,
  ...Array.from({ length: 6 }, (_, i) => `${G}✔${Z} 用例 ${i + 1} 通过 ${D}(0.${i}ms)${Z}`),
  `${B}ℹ pass 6${Z}  ${B}ℹ fail 0${Z}`,
].join('\n');
const BASH_FAIL_OUTPUT = [
  `${B}> frontend@0.0.8 test${Z}`,
  `${G}✔${Z} 用例 1 通过 ${D}(0.1ms)${Z}`,
  `${Y}⚠ 2 个用例被跳过${Z}`,
  `${R}✖ 空行兜底删掉之后，后面的原子跟着消失${Z}`,
  `  ${R}AssertionError: 3 !== 1${Z}`,
  `${B}ℹ fail 1${Z}`,
].join('\n');

const READ_LINES = NEW_TS.split('\n').map((text, i) => ({ number: i + 41, text }));

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 2px' }}>{title}</h2>
      {note !== undefined && (
        <p style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', opacity: 0.7, margin: '0 0 8px' }}>
          {note}
        </p>
      )}
      <div style={{ background: 'var(--color-bg-panel)', borderRadius: 10, padding: '10px 14px' }}>{children}</div>
    </section>
  );
}

/*
  这四个视图都自己管展开状态，没有 defaultOpen 这种 prop（上游就没有，我们没加）。
  fixture 要画「展开」那一种，只能替读者点一下。

  用 ref 挡住第二次，不是查 aria-expanded：StrictMode 下 effect 会跑两遍，而两遍之间
  DOM 还没更新，查属性查到的仍是 'false'，于是开了又关，截出来还是收起的那张。
  选择器要连 `[role="button"]` 一起收：DisclosureRow 的展开目标是那个整行的 div
  （expandOnRowClick），不是 <button>；bash 那一行的目标同样是 div。
*/
function ClickToExpand({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (clicked.current) return;
    clicked.current = true;
    const target = ref.current?.querySelector<HTMLElement>('[role="button"], button[aria-expanded]');
    target?.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** ?theme=light 时把主题拨过去，截图脚本靠它拿浅色那一张。 */
function ThemePin() {
  const { theme, toggleTheme } = useTheme();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const wanted = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
    if (theme !== wanted) toggleTheme();
  }, [theme, toggleTheme]);
  return null;
}

function Fixture() {
  return (
    <div style={{ background: 'var(--color-bg)', minHeight: '100vh', padding: '24px 32px 64px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto', color: 'var(--color-text)' }}>

        <Section title="FileMutationRow —— 单文件改动（展开）" note="折叠行右端的 +N -M 由 ToolRow 自己算">
          <ClickToExpand>
            <FileMutationRow
              labels={ROW_LABELS}
              variant="edit"
              toolName="Edit"
              title="编辑文件"
              summary="frontend/src/plugins/xyz/parse.ts"
              state="ok"
              filePath="frontend/src/plugins/xyz/parse.ts"
              onOpenFile={path => console.log('open', path)}
              hunks={[{ path: 'frontend/src/plugins/xyz/parse.ts', oldText: OLD_TS, newText: NEW_TS }]}
              inspect={() => console.log('inspect')}
            />
          </ClickToExpand>
        </Section>

        <Section
          title="FileMutationRow —— 多文件 + 被截断（折叠）"
          note="truncated 接到 summarySuffix 上：DiffBlock 和 ToolRow 都没有别的地方能放这半句"
        >
          <FileMutationRow
            labels={ROW_LABELS}
            variant="write"
            toolName="Write"
            title="写入文件"
            summary="3 个文件"
            state="ok"
            truncated
            truncatedLabel="已截断"
            hunks={[
              { path: 'frontend/src/plugins/xyz/parse.ts', oldText: OLD_TS, newText: NEW_TS },
              { path: 'frontend/tests/xyz-parse.test.ts', oldText: null, newText: "import { test } from 'node:test';\ntest('空行不再截断', () => {});\n" },
            ]}
          />
        </Section>

        <Section title="FileMutationRow —— 新建文件（展开，oldText 为 null）">
          <ClickToExpand>
            <FileMutationRow
              labels={ROW_LABELS}
              variant="write"
              toolName="Write"
              title="写入文件"
              summary="frontend/tests/xyz-parse.test.ts"
              state="ok"
              filePath="frontend/tests/xyz-parse.test.ts"
              onOpenFile={path => console.log('open', path)}
              hunks={[{
                path: 'frontend/tests/xyz-parse.test.ts',
                oldText: null,
                newText: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('空行不再截断', () => {\n  assert.equal(parseXyz(SAMPLE).atoms.length, 3);\n});\n",
              }]}
            />
          </ClickToExpand>
        </Section>

        <Section title="BashRow —— 命令成功（展开）">
          <ClickToExpand>
            <BashRow
              labels={BASH_LABELS}
              title="运行命令"
              summary="npm test --workspace frontend"
              state="ok"
              command="npm test --workspace frontend"
              cwd="/Users/me/roost"
              home="/Users/me"
              output={BASH_OK_OUTPUT}
              inspect={() => console.log('inspect')}
            />
          </ClickToExpand>
        </Section>

        <Section
          title="BashRow —— 命令失败（展开）"
          note="我们拿不到退出码，所以卡片里那颗点仍是绿的「完成」；红点和红字在卡片外面的标题行上，由 state='error' 给"
        >
          <ClickToExpand>
            <BashRow
              labels={BASH_LABELS}
              title="运行命令"
              summary="npm test --workspace frontend"
              state="error"
              errorSummary="AssertionError: 3 !== 1（fail 1）"
              command="npm test --workspace frontend"
              cwd="/Users/me/roost"
              home="/Users/me"
              output={BASH_FAIL_OUTPUT}
            />
          </ClickToExpand>
        </Section>

        <Section title="BashRow —— 退出码拿得到时（展开）" note="别的 CLI 给了退出码，exitCode 透传，卡片自己就能说失败">
          <ClickToExpand>
            <BashRow
              labels={BASH_LABELS}
              title="运行命令"
              summary="npm run verify"
              state="error"
              errorSummary="退出码 1"
              command="npm run verify"
              cwd="/Users/me/roost"
              home="/Users/me"
              output={BASH_FAIL_OUTPUT}
              exitCode={1}
            />
          </ClickToExpand>
        </Section>

        <Section title="BashRow —— 还在跑（展开）" note="终端卡只画提示符行">
          <ClickToExpand>
            <BashRow
              labels={BASH_LABELS}
              title="运行命令"
              summary="npm run dev --prefix frontend"
              state="running"
              command="npm run dev --prefix frontend"
              cwd="/Users/me/roost"
              home="/Users/me"
            />
          </ClickToExpand>
        </Section>

        <Section title="BashRow —— 没解析出命令（展开，退回参数 / 输出兜底卡）">
          <ClickToExpand>
            <BashRow
              labels={BASH_LABELS}
              title="运行命令"
              summary="（参数里没有 command）"
              state="error"
              errorSummary="Bash: missing required parameter `command`"
              command={null}
              body={'{\n  "description": "跑一遍前端测试"\n}'}
              output="Error: missing required parameter `command`"
            />
          </ClickToExpand>
        </Section>

        <Section title="BashRow —— 折叠态（失败，红点 + 红字）">
          <BashRow
            labels={BASH_LABELS}
            title="运行命令"
            summary="npm test --workspace frontend"
            state="error"
            errorSummary="AssertionError: 3 !== 1（fail 1）"
            command="npm test --workspace frontend"
            output={BASH_FAIL_OUTPUT}
          />
        </Section>

        <Section title="ReadRow —— 读文件带行号（展开）" note="totalLines 给得出来时才画「显示 N / 共 M」">
          <ClickToExpand>
            <ReadRow
              labels={ROW_LABELS}
              variant="read"
              toolName="Read"
              title="读取文件"
              summary="frontend/src/plugins/xyz/parse.ts"
              state="ok"
              filePath="frontend/src/plugins/xyz/parse.ts"
              line={41}
              onOpenFile={(path, options) => console.log('open', path, options)}
              read={{ label: 'frontend/src/plugins/xyz/parse.ts', lines: READ_LINES, totalLines: 186, lang: 'typescript' }}
              inspect={() => console.log('inspect')}
            />
          </ClickToExpand>
        </Section>

        <Section
          title="ReadRow —— 拿不到文件总行数（展开）"
          note="Claude 的结果文本里解不出 totalLines，只能给 lines.length；ReadBlock 少画一句，而不是画一个编的数字"
        >
          <ClickToExpand>
            <ReadRow
              labels={ROW_LABELS}
              variant="read"
              toolName="Read"
              title="读取文件"
              summary="AGENTS.md"
              state="ok"
              filePath="AGENTS.md"
              read={{ label: 'AGENTS.md', lines: READ_LINES.slice(0, 6), totalLines: 6 }}
            />
          </ClickToExpand>
        </Section>

        <Section
          title="ToolView —— 走我们自己的分派，数据是真实形状（展开）"
          note="结果文本是 Claude 的 cat -n 形状（每行「行号 \t 正文」），由 read-card.ts 折算成 ReadBlock 的卡"
        >
          <ClickToExpand>
            <ToolView block={{
              kind: 'tool', id: 'r1', name: 'Read', failed: false,
              args: '{"file_path":"/Users/me/roost/frontend/src/plugins/xyz/parse.ts","offset":40,"limit":11}',
              result: READ_LINES.map(l => `${l.number}\t${l.text}`).join('\n'),
            }} />
          </ClickToExpand>
        </Section>

        <Section
          title="ToolView —— 读的是图片，数据不够就不认领"
          note="结果里一行带行号的都没有。退回通用卡片，而不是画一块有边框有标题的空代码区"
        >
          <ToolView block={{
            kind: 'tool', id: 'r2', name: 'Read', failed: false,
            args: '{"file_path":"/Users/me/roost/scratchpad/shot.png"}',
            result: '[图片内容已省略]',
          }} />
        </Section>

        <Section title="GenericToolCard —— 认不出来的工具（展开）">
          <ClickToExpand>
            <GenericToolCard
              labels={ROW_LABELS}
              variant="others"
              toolName="mcp__weather__forecast"
              title="调用工具"
              summary="mcp__weather__forecast"
              state="ok"
              bodyRaw={'{\n  "city": "杭州",\n  "days": 3\n}'}
              output={'杭州 未来三天\n周一 26°C 多云\n周二 24°C 小雨\n周三 27°C 晴'}
              inspect={() => console.log('inspect')}
            />
          </ClickToExpand>
        </Section>

        <Section title="GenericToolCard —— 七种 variant 的图标（折叠）" note="preflight 把 svg 变成 display:block 的话，这一列会当场散架">
          {(['search', 'read', 'bash', 'write', 'edit', 'code', 'others'] as const).map(variant => (
            <GenericToolCard
              key={variant}
              labels={ROW_LABELS}
              variant={variant}
              title="调用工具"
              summary={variant}
              state="ok"
              output="（略）"
            />
          ))}
        </Section>

        <Section title="GenericToolCard —— 四种状态（折叠）">
          {(['ok', 'running', 'error', 'stopped'] as const).map(state => (
            <GenericToolCard
              key={state}
              labels={ROW_LABELS}
              variant="others"
              title="调用工具"
              summary={state === 'error' ? '' : `state = ${state}`}
              errorSummary="Tool call failed: connection reset by peer"
              state={state}
              output="（略）"
            />
          ))}
        </Section>

      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><ThemePin /><Fixture /></ThemeProvider></StrictMode>,
);
