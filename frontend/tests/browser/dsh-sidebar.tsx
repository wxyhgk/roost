// 隔离的浏览器 fixture：把 vendor/dsh/sidebar 的左栏外壳和会话行画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-sidebar.html 就行。
//
// **这是唯一能发现 Tailwind preflight 撞车的手段。** NOTICE.md 第 3 条记了两次这样的事故：
// 上游那批 CSS 建立在它自己的 reset 上，搬到我们的 reset 上必然缺一块，而且两次都是
// typecheck 和单测看不出、只有画出来才发现的。这一批带进来的 inline svg 特别多
// （品牌标记、折叠开关、新建、搜索、文件夹、三角、状态点），preflight 的
// `svg { display: block }` 只要漏掉一个 flex 容器就会把图标和文字拆成两行。
// 所以页面底部有一条**实测读数**，直接把四个几何数字打出来，不用开 devtools：
//   1. 折叠轨宽 56px —— 折叠态是图标轨，**永远不是宽度 0**
//   2. 新建按钮 38px 高，且 scrollHeight 不超过它（图标没被挤到第二行）
//   3. 会话行 32px 高
//   4. 分组头行 34px 高
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLayoutEffect, useRef } from 'react';
import { SidebarRoot } from '../../src/vendor/dsh/sidebar/SidebarRoot';
import { GroupRow, RowIconButton, SessionRow } from '../../src/vendor/dsh/sidebar/Rows';
import { SidebarBrowser, SidebarGroup } from '../../src/vendor/dsh/sidebar/WorkspaceBrowser';
import { relativeTime, type RelativeTime } from '../../src/vendor/dsh/relative-time';
import { IconEllipsisOutline16, IconProjectAddOutline16 } from '../../src/vendor/dsh/icons/index';
import type { StateDotState } from '../../src/vendor/dsh/StateDot';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// 这批 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。真正接进 features 的时候
// 由 vendor/dsh 的入口带进来，fixture 里单独引一次。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

/*
  **令牌已经补齐了**（`tokens.css` 末尾「侧栏：按钮面与反相文字」那一段）。

  这一页最初是在令牌还空着的时候画的，那时候看到的是：「新建对话」那颗钮**只剩描边、
  没有底色**，版本号小徽章**深色下白底白字、浅色下黑底黑字**。留这段是为了记住
  **为什么不该在 fixture 里补假令牌**——补了就等于把「令牌桥断了」这件事藏起来，
  而这一页存在的全部意义就是把它暴露出来。

  当时空着的四个，现在的去向：

    --dsw-alias-button-elevated-fill    → var(--color-bg-raised)，已接
    --dsw-alias-label-primary-inverted  → var(--color-bg)，已接（它跟着主题**反着走**，
                                          因为底色是不跟主题翻的强调色）
    --dsw-alias-interactive-bg-active   → var(--color-bg-active)，已接
    --dsw-alias-label-dimmed            **仍然没接**：只被没搬的重命名对话框用到，接了是空转

  **故意不在这里补假值**：补了就等于把它们藏起来，接线的人看到一张「已经对了」的图，
  真接上去才发现钮是空心的。CSS 里 var() 取不到值是**整条属性作废**，不是回退到默认——
  所以缺令牌的表现从来不是「颜色差一点」。建议的映射见任务回复里的清单。
*/

/* 上游把档位的文字留在各自的词典里。这是 fixture 自己的一份（英文紧凑档，和上游 en 一致）。 */
const TIME_WORDS: Record<RelativeTime['unit'], (n: number) => string> = {
  now: () => 'now',
  minutes: n => `${n}min`,
  hours: n => `${n}h`,
  days: n => `${n}d`,
  months: n => `${n}mo`,
  years: n => `${n}y`,
};
const timeLabel = (at: number, now: number) => {
  const { unit, n } = relativeTime(at, now);
  return TIME_WORDS[unit](n);
};

const NOW = Date.now();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

interface Row {
  id: string;
  title: string;
  at: number;
  state?: StateDotState;
  /** 相对时间不走 relativeTime，直接写死——用来看超长文字会不会把标题挤没。 */
  rawTime?: string;
}

const ROWS: readonly Row[] = [
  { id: 'a', title: '前端', at: NOW - 30_000, state: 'ongoing' },
  { id: 'b', title: '把左栏换成 deepseek-harness 的壳', at: NOW - 12 * MIN, state: 'warning' },
  {
    id: 'c',
    // 长标题：要在栏边**干净地省略号**，不是被硬切，也不是把时间挤出去。
    title: '重新梳理发布流程里资产和外壳的先后顺序，并把那条踩了三次的坑写进 AGENTS.md',
    at: NOW - 3 * HOUR,
  },
  { id: 'd', title: '终端恢复', at: NOW - 2 * DAY, state: 'error' },
  { id: 'e', title: '分子编辑器 iframe 入口', at: NOW - 5 * DAY, state: 'done' },
  // 很长的相对时间：中文档位（「3 个月前」）比英文的 `3mo` 宽得多，行尾不能因此散架。
  { id: 'f', title: '很久以前的一条', at: NOW - 100 * DAY, rawTime: '3 个月前' },
  { id: 'g', title: '再往前一条', at: NOW - 400 * DAY },
  { id: 'h', title: '第八条，用来触发「还有 n 条」', at: NOW - 500 * DAY },
];

const BROWSER_LABELS = {
  section: '对话',
  search: '搜索',
  searchPlaceholder: '搜索对话…',
  searchClear: '清空',
};
const GROUP_LABELS = { expand: (n: number) => `还有 ${n} 条`, collapse: '收起' };
const ROOT_LABELS = {
  newSession: '新建对话',
  newSessionLabel: '新建对话',
  toggleOpen: '展开左栏',
  toggleCollapse: '收起左栏',
  panels: '全局面板',
};

/** 品牌标记：一个 24px 的方块，占位用——我们没有上游那条鲸鱼（FishLogo 没搬）。 */
function BrandMark() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 12h10M12 7v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const renderRow = (selectedId: string, onSelect: (id: string) => void) => (row: Row) => (
  <SessionRow
    key={row.id}
    title={row.title}
    state={row.state}
    stateLabel={row.state}
    timeLabel={row.rawTime ?? timeLabel(row.at, NOW)}
    active={row.id === selectedId}
    onOpen={() => { onSelect(row.id); }}
    menu={<RowIconButton label="更多" onClick={() => {}}><IconEllipsisOutline16 /></RowIconButton>}
  />
);

/** 昨天那组用的两条，形状和 ROWS 一样。 */
const YESTERDAY: readonly Row[] = [
  { id: 'y1', title: '昨天的一条', at: NOW - DAY, rawTime: '1d' },
  { id: 'y2', title: '昨天的另一条', at: NOW - DAY, state: 'done', rawTime: '1d' },
];

/** 一整栏（展开或折叠）。`collapsed` 为真时外面那个盒子锁死 56px，模拟 Shell 的栅格。 */
function Column({ collapsed, onToggle, tag }: { collapsed: boolean; onToggle: () => void; tag: string }) {
  const [selected, setSelected] = useState('b');
  const [query, setQuery] = useState('');
  const [expandedGroup, setExpandedGroup] = useState(true);
  return (
    <div>
      <div style={{ font: 'var(--dsw-font-xxs-12)', color: 'var(--color-text-dim)', marginBottom: 6 }}>{tag}</div>
      <div
        data-box=""
        style={{
          // content-box：preflight 把一切设成 border-box，那样 1px 描边会把 56px 的轨吃成 54，
          // 读数就永远对不上——量的是盒子，不是轨。
          boxSizing: 'content-box',
          width: collapsed ? 56 : 280,
          height: 620,
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <SidebarRoot
          collapsed={collapsed}
          width={280}
          labels={ROOT_LABELS}
          onNewSession={() => {}}
          onToggle={onToggle}
          brandMark={<BrandMark />}
          brandName="Roost"
          buildVersion="0.0.8-7514e95"
          region={owner => (
            <SidebarBrowser
              wide={owner.wide}
              labels={BROWSER_LABELS}
              query={query}
              onQueryChange={setQuery}
              onExpandSidebar={owner.expandSidebar}
              headerActions={(
                <button
                  type="button"
                  style={{
                    width: owner.wide ? 28 : 36, height: owner.wide ? 28 : 36,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    border: 'none', borderRadius: '50%', background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)', padding: 0,
                  }}
                  aria-label="新建分组"
                >
                  <IconProjectAddOutline16 size={owner.wide ? 16 : 18} />
                </button>
              )}
            >
              <SidebarGroup
                labels={GROUP_LABELS}
                items={expandedGroup ? ROWS : []}
                renderItem={renderRow(selected, setSelected)}
                header={(
                  <GroupRow
                    label="今天"
                    expanded={expandedGroup}
                    containsActive
                    onToggle={() => { setExpandedGroup(v => !v); }}
                  />
                )}
              />
              <SidebarGroup
                labels={GROUP_LABELS}
                items={YESTERDAY}
                renderItem={renderRow(selected, setSelected)}
                header={<GroupRow label="昨天" expanded onToggle={() => {}} />}
              />
            </SidebarBrowser>
          )}
          settings={wide => (
            <button
              type="button"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: wide ? '100%' : 36, height: 36, padding: wide ? '0 8px' : 0,
                justifyContent: wide ? 'flex-start' : 'center',
                border: 'none', borderRadius: 8, background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)', font: 'inherit',
              }}
              aria-label="设置"
            >
              <span style={{ display: 'inline-flex' }}><BrandMark /></span>
              {wide && <span>设置</span>}
            </button>
          )}
        />
      </div>
    </div>
  );
}

/** 实测读数。四个数字里任何一个不对，就是 reset 撞上了。 */
function Measurements({ probe }: { probe: React.RefObject<HTMLDivElement | null> }) {
  const [text, setText] = useState('（测量中）');
  useLayoutEffect(() => {
    const id = window.setTimeout(() => {
      const host = probe.current;
      if (host === null) return;
      const pick = (sel: string) => host.querySelector<HTMLElement>(sel);
      // `[data-box]` 是 fixture 自己那个锁死宽度的盒子，它的独子就是 SidebarRoot 的 .root。
      const rail = pick('[data-rail] [data-box] > *');
      // **注意别选中品牌按钮**：上游让它和新建按钮共用同一个 aria-label（品牌本身就是新建
      // 会话的快捷方式），所以必须按「是 .root 的直接子元素」来区分——品牌按钮藏在 .logoRow 里。
      const newSession = pick('[data-wide] [data-box] > div > button[aria-label="新建对话"]');
      const row = pick('[data-wide] [role="treeitem"][aria-selected]');
      const group = pick('[data-wide] [role="treeitem"][aria-expanded]');
      const line = (label: string, got: number | undefined, want: number) =>
        `${label} ${got === undefined ? '?' : Math.round(got)} / 期望 ${want} ${got !== undefined && Math.round(got) === want ? '✔' : '✖'}`;
      setText([
        line('折叠轨宽', rail?.getBoundingClientRect().width, 56),
        line('新建按钮高', newSession?.getBoundingClientRect().height, 38),
        `新建按钮 scrollHeight ${newSession?.scrollHeight ?? '?'} ${(newSession?.scrollHeight ?? 99) <= 38 ? '✔ 图标和文字同一行' : '✖ 被拆成两行——preflight 的 svg{display:block} 漏了一处'}`,
        line('会话行高', row?.getBoundingClientRect().height, 32),
        line('分组头行高', group?.getBoundingClientRect().height, 34),
      ].join('\n'));
    }, 400);
    return () => { window.clearTimeout(id); };
  }, [probe]);
  return (
    <pre style={{
      margin: '24px 0 0', padding: 12, whiteSpace: 'pre-wrap',
      font: 'var(--dsw-font-markdown-code-block)', color: 'var(--color-text)',
      background: 'var(--color-bg-raised)', borderRadius: 8,
    }}>{text}</pre>
  );
}

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const probe = useRef<HTMLDivElement>(null);
  return (
    <div style={{ padding: 24, color: 'var(--color-text)', minHeight: '100vh', background: 'var(--color-bg)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <button type="button" onClick={toggleTheme}>主题：{theme}</button>
        <button type="button" onClick={() => { setCollapsed(v => !v); }}>
          左边那栏：{collapsed ? '折叠' : '展开'}（点一下看淡入淡出）
        </button>
        <span style={{ font: 'var(--dsw-font-xxs-12)', color: 'var(--color-text-dim)' }}>
          令牌已补齐（见文件顶上那段）。这一页**不补假令牌**——补了就把「令牌桥断了」藏起来
        </span>
      </div>

      <div ref={probe} style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div data-wide="">
          <Column collapsed={collapsed} onToggle={() => { setCollapsed(v => !v); }} tag="可切换的一栏（默认展开）" />
        </div>
        <div data-rail="">
          <Column collapsed onToggle={() => {}} tag="折叠态：56px 图标轨，不是宽度 0" />
        </div>
        <div>
          <Column collapsed={false} onToggle={() => {}} tag="展开态：280px" />
        </div>
      </div>

      <Measurements probe={probe} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
