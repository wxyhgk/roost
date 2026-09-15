// 隔离的浏览器 fixture：把 vendor/dsh/chat/tool 的 ToolRow 用假数据画一遍——
// 四种状态（running / ok / error / stopped）× 几种卡片（有 diff 的、有终端输出的、
// 只有文本的、认不出来的），外加 read / search / web 三种分派。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-tool-row.html 就行。
//
// 要看的是三样单测钉不住的东西：CSS Module 有没有打进来、tokens.css 的 --dsw-* 有没有
// 接上、Tailwind 的 preflight 有没有把哪块打歪（svg 变 display:block、列表标记清零——
// 这两条我们已经栽过两次，见 vendor/dsh/NOTICE.md 里那条「模式」）。
//
// 右上角两颗钮：一颗切深浅，一颗把所有行一次展开／收起（折叠态和展开态要分别看一遍）。
// 截图脚本直接改 documentElement.dataset.theme、或者点
// `[data-fixture="expand-all"]` 都行，两条路同一个开关。
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRow, type ToolRowLabels } from '../../src/vendor/dsh/chat/tool/ToolRow.tsx';
import type { DiffCardModel } from '../../src/vendor/dsh/chat/tool/models/diff-card-model.ts';
import type { ReadCardModel } from '../../src/vendor/dsh/chat/tool/models/read-card-model.ts';
import type { SearchCardModel } from '../../src/vendor/dsh/chat/tool/models/search-card-model.ts';
import type { TerminalCardModel } from '../../src/vendor/dsh/chat/tool/models/terminal-card-model.ts';
import type { WebCardModelProps } from '../../src/vendor/dsh/chat/tool/models/web-card-model.ts';
import {
  toolRowModel, type ToolRowState,
} from '../../src/vendor/dsh/chat/tool/models/tool-call-model.ts';
import {
  IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconGlobeOutline14, IconSearchOutline16,
} from '../../src/vendor/dsh/icons/index.tsx';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
import '../../src/index.css';

/* ToolRow 一个字符串都不自带（vendor/dsh 整批组件的惯例），所以这里把全套文案拼一次。
   五个积木的 labels 是必填的——理由见 ToolRow.tsx 里 ToolRowLabels 上面那段。 */
const fold = {
  collapseAria: '收起',
  expandAria: (n: number) => `展开其余 ${n} 行`,
  collapse: '收起',
  expand: (n: number) => `… 还有 ${n} 行`,
};
const copy = { copy: '复制', copied: '已复制' };
const markdown = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

const labels: ToolRowLabels = {
  running: '运行中',
  failed: '失败',
  stopped: '已中断',
  input: 'IN',
  output: 'OUT',
  inspect: '查看',
  ...copy,
  diff: { ...copy, ...fold, files: n => `${n} 个文件` },
  read: { ...copy, ...fold, window: (shown, total) => `显示 ${shown} / ${total} 行` },
  search: {
    ...copy,
    ...fold,
    noResults: '没有匹配',
    pathsSummary: (shown, total, truncated) => `${shown} / ${total} 个文件${truncated ? '（已截断）' : ''}`,
    matchesSummary: (shown, total, files, truncated) =>
      `${shown} / ${total} 处匹配，${files} 个文件${truncated ? '（已截断）' : ''}`,
  },
  terminal: {
    ...copy,
    ...fold,
    signal: signal => `信号 ${signal}`,
    exitCode: code => `退出码 ${code}`,
    running: '运行中',
    failed: '失败',
    done: '完成',
    noOutput: '没有输出',
  },
  web: { noResults: '没有结果', sourcesTruncated: '来源已截断', http: 'HTTP', contentTruncated: '内容已截断', markdown },
};

/* ---- 假数据 ------------------------------------------------------------- */

const G = '\u001b[32m', R = '\u001b[31m', D = '\u001b[90m', B = '\u001b[1m', Z = '\u001b[0m';
const TERMINAL_OUTPUT = [
  `${B}> frontend@0.0.8 test${Z}`,
  ...Array.from({ length: 12 }, (_, i) => `${G}✔${Z} 用例 ${i + 1} 通过 ${D}(0.${i}ms)${Z}`),
  `${R}✖ 空行兜底删掉之后，后面的原子跟着消失${Z}`,
  `  ${R}AssertionError: 3 !== 1${Z}`,
  `${B}ℹ fail 1${Z}`,
].join('\n');

const OLD_TS = `export function publish(dist: string) {
  copyDir(dist, shareRoot);
  return { ok: true };
}`;
const NEW_TS = `export function publish(dist: string) {
  // 资产先、外壳后：顺序反了会造出「新外壳 + 旧资产」，入口脚本 404、页面纯白。
  publishAssets(dist, assetsRoot);
  publishShell(dist, webRoot);
  return { ok: true };
}`;

const diffCard: DiffCardModel = {
  card: { diffs: [{ path: 'deploy/publish.mjs', oldText: OLD_TS, newText: NEW_TS }] },
};

const terminalCard: TerminalCardModel = {
  card: {
    command: 'npm test --workspaces --if-present',
    cwd: '~/Code/roost',
    output: TERMINAL_OUTPUT,
    exitCode: 1,
  },
  description: '跑一遍全仓测试',
};

const runningTerminalCard: TerminalCardModel = {
  card: { command: 'npm run build --workspace frontend', cwd: '~/Code/roost', running: true },
  description: '构建前端',
};

const readCard: ReadCardModel = {
  label: 'frontend/src/vendor/dsh/tokens.css',
  lines: NEW_TS.split('\n').map((text, i) => ({ number: i + 41, text })),
  totalLines: 320,
  lang: 'typescript',
};

const searchCard: SearchCardModel = {
  card: {
    kind: 'matches',
    truncated: false,
    total: 3,
    files: [
      { path: 'deploy/publish.mjs', matches: [{ lineNumber: 12, line: 'export function publishAssets(dist, root) {' }] },
      {
        path: 'scripts/install-service.mjs',
        matches: [
          { lineNumber: 88, line: '  await publishAssets(distDir, assetsRoot);' },
          { lineNumber: 91, line: '  await publishShell(distDir, webRoot);' },
        ],
      },
    ],
  },
  recovery: undefined,
};

const webCard: WebCardModelProps = {
  kind: 'fetch',
  url: 'https://caddyserver.com/docs/caddyfile/directives/file_server',
  statusCode: 200,
  truncated: true,
};

const ARGS_JSON = JSON.stringify(
  { command: 'npm test --workspaces --if-present', description: '跑一遍全仓测试', timeout: 600000 },
  null,
  2,
);
/** 认不出来的那一路：参数不是 JSON（流式截断的半截文本），工具名也不在变体表里。 */
const ARGS_BROKEN = '{"pattern":"publishAsse';

const OUTPUT_TEXT = [
  'frontend  ℹ tests 214  pass 214  fail 0',
  'backend   ℹ tests 388  pass 387  fail 1',
  '  ✖ daemon-restart.test.ts › 重启 backend 不动 PTY',
].join('\n');
const ERROR_TEXT = 'Error: ENOENT: no such file or directory, open \'~/.local/share/roost/web/index.html\'\n  at Object.openSync (node:fs:596:3)';

/* ---- 布局 --------------------------------------------------------------- */

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 8px' }}>
        {title}
        {note !== undefined && <span style={{ opacity: 0.7 }}>　—— {note}</span>}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </section>
  );
}

const STATES: readonly ToolRowState[] = ['running', 'ok', 'error', 'stopped'];

/** 一种卡片，四个状态各画一行。 */
function StateQuartet({ render }: { render: (state: ToolRowState) => ReactNode }) {
  return <>{STATES.map(state => <div key={state}>{render(state)}</div>)}</>;
}

function Switches() {
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const button = {
    padding: '4px 10px', borderRadius: 6,
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg-panel)', color: 'var(--color-text)',
    font: 'var(--dsw-font-xs-13)', cursor: 'pointer',
  };
  /*
    ToolRow 的展开态是它自己的 useState，外面拿不到——所以这里按 DOM 来：
    DisclosureRow 在可展开的那一行上留了 `data-disclosure-row` + `aria-expanded`，
    照 aria-expanded 和目标态比，只点需要翻的那些（无差别点一遍会把已经展开的收回去）。
  */
  const expandAll = () => {
    const next = !open;
    setOpen(next);
    for (const row of document.querySelectorAll('[data-disclosure-row][data-expandable]')) {
      if ((row.getAttribute('aria-expanded') === 'true') !== next) (row as HTMLElement).click();
    }
  };
  return (
    <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 10, display: 'flex', gap: 8 }}>
      <button type="button" data-fixture="expand-all" onClick={expandAll} style={button}>
        {open ? '全部收起' : '全部展开'}
      </button>
      <button type="button" data-fixture="theme-switch" onClick={toggleTheme} style={button}>
        {theme === 'dark' ? '切到浅色' : '切到深色'}
      </button>
    </div>
  );
}

function Fixture() {
  return (
    <div style={{ width: 860, margin: '0 auto', padding: '24px 24px 80px', color: 'var(--color-text)' }}>
      <Switches />

      <Section title="一、只有文本" note="展开是 IN/OUT 两段；running 没有 OUT，扫光在标题行上">
        <StateQuartet render={state => (
          <ToolRow
            labels={labels}
            variant="bash"
            toolName="bash"
            icon={<IconCodeOutline16 />}
            title="终端"
            summary="npm test --workspaces --if-present"
            state={state}
            bodyRaw={ARGS_JSON}
            output={state === 'running' ? null : state === 'error' ? ERROR_TEXT : OUTPUT_TEXT}
            errorSummary={state === 'error' ? ERROR_TEXT.split('\n')[0] : null}
            inspect={() => { /* 悬停才出现的那颗小钮，点了什么也不做 */ }}
          />
        )} />
      </Section>

      <Section title="二、有 diff 的" note="折叠行右边那串 +N -M 是 ToolRow 自己从卡片算的">
        <StateQuartet render={state => (
          <ToolRow
            labels={labels}
            variant="edit"
            toolName="edit"
            icon={<IconEditOutline16 />}
            title="改文件"
            summary="deploy/publish.mjs"
            state={state}
            filePath="deploy/publish.mjs"
            filePathLine={12}
            onOpenFile={(path, options) => { console.log('open', path, options); }}
            diff={diffCard}
            bodyRaw={ARGS_JSON}
            errorSummary={state === 'error' ? '权限不足：deploy/publish.mjs 只读' : null}
          />
        )} />
      </Section>

      <Section title="三、有终端输出的" note="卡片自带描述时它顶掉摘要；ANSI 的红绿是解析出来的，不是 CSS 抹的">
        <StateQuartet render={state => (
          <ToolRow
            labels={labels}
            variant="bash"
            toolName="bash"
            icon={<IconCodeOutline16 />}
            title="终端"
            summary="npm test"
            state={state}
            terminal={state === 'running' ? runningTerminalCard : terminalCard}
            errorSummary={state === 'error' ? '命令没找到：npm' : null}
          />
        )} />
      </Section>

      <Section title="四、认不出来的" note="others 变体：工具名进摘要，参数是半截 JSON 所以原样显示">
        <StateQuartet render={state => {
          const model = toolRowModel({
            toolName: 'workspace_messaging__agent_send',
            argsRaw: ARGS_BROKEN,
            callId: 'toolu_01AbCdEf',
            result: state === 'running' ? null : state === 'error' ? ERROR_TEXT : '已送达',
            settled: state !== 'running',
            interrupted: state === 'stopped',
            isError: state === 'error',
          });
          return (
            <ToolRow
              labels={labels}
              variant={model.variant}
              toolName="workspace_messaging__agent_send"
              icon={<IconCodeOutline16 />}
              title="工具调用"
              summary={model.summary}
              state={model.state}
              bodyRaw={model.bodyRaw}
              output={model.output}
              errorSummary={model.errorSummary}
            />
          );
        }} />
      </Section>

      <Section title="五、参数全缺" note="名字、参数、结果三样全没有也要画得出一行——兜底那条路">
        <ToolRow
          labels={labels}
          variant="others"
          icon={<IconCodeOutline16 />}
          title="工具调用"
          summary=""
          state="ok"
        />
      </Section>

      <Section title="六、其余三种分派" note="read / search / web，证明卡片链上每一支都接到了积木">
        <ToolRow
          labels={labels} variant="read" toolName="read" icon={<IconBrowseOutline16 />}
          title="读文件" summary="frontend/src/vendor/dsh/tokens.css" state="ok" read={readCard}
        />
        <ToolRow
          labels={labels} variant="search" toolName="grep" icon={<IconSearchOutline16 />}
          title="搜索" summary="publishAssets" state="ok" search={searchCard}
        />
        <ToolRow
          labels={labels} variant="read" toolName="web_fetch" icon={<IconGlobeOutline14 />}
          title="抓网页" summary="caddyserver.com/docs/…/file_server" state="ok" web={webCard}
        />
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
