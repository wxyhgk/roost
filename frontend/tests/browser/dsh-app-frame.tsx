// 隔离的浏览器 fixture：用假内容把 vendor/dsh/layout 的三栏外壳画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-app-frame.html 就行。
//
// 为什么非要有这一页：`frontend/tests` 没有 jsdom，`node --test` 也加载不了 `.module.css`，
// 所以 typecheck 和单测**都看不见**这套外壳的一大半。NOTICE.md 第 3 条已经记了两次这样的
// 事故（列表标记全不见、引用芯片被拆成两行），两次都是画出来才发现的。这一页要验四件事：
//   1. **CSS Module 打包**——类名接上了没有。没接上的话三栏会摞成三个块，而不是并排。
//   2. **令牌桥**——左栏底色、发丝线、折叠过渡的曲线。少一个令牌的症状不是「颜色略偏」，
//      是左栏透明、`transition` 整条作废（简写里碰上未定义变量就是整条丢掉）。
//   3. **让步顺序**——把窗口从宽拖到窄，看右栏先缩到 300、再整轨消失、中栏这时才掉破 400、
//      左栏自始至终不动。页面底部有实测读数，不用开 devtools。
//   4. **持久化**——这是我们相对上游唯一的行为偏离（上游 README 写着 "Layout state resets
//      on reload"）。拖完左栏刷新一下，宽度应该还在。
import { StrictMode, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppFrame } from '../../src/vendor/dsh/layout/AppFrame';
import {
  browserLayoutPersistence, useLayoutState, RIGHTBAR_MIN, SIDEBAR_AUTO_COLLAPSE,
} from '../../src/vendor/dsh/layout';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
import '../../src/index.css';

/*
  这一页**故意不在本地兜底任何令牌**。外壳要的三个（--ds-ease-in-out、
  --ds-transition-duration-slow、--dsw-specific-sidebar-fill）都得来自 vendor/dsh/tokens.css，
  在这里补一份就等于把「令牌桥断了」这件事藏起来——而那正是这一页要发现的两类事故之一。
  症状长这样：左栏底色变透明（和中栏连成一片），折叠/展开没有过渡（栏宽瞬间跳过去）。
*/

/* 持久化口子。模块级常量而不是渲染里现造，这样它天然稳定。 */
const PERSISTENCE = browserLayoutPersistence('roost-fixture-app-frame');

const CONVERSATIONS = [
  ['xyz 解析器少了原子', '2 分钟前'],
  ['把 break 改回 continue', '1 小时前'],
  ['终端服务重启会杀掉谁', '昨天'],
  ['资产先、外壳后：发布顺序', '昨天'],
  ['依赖边界为什么是强制的', '3 天前'],
  ['把三栏外壳搬进 vendor', '上周'],
] as const;

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: 'var(--color-text)' }}>
      <div style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 8, height: 44,
        padding: collapsed ? '0 16px' : '0 12px 0 16px',
      }}>
        {/* 折叠态是一条 24px 图标列夹在两个 16px 内边距之间——正好 SIDEBAR_COLLAPSED = 56。 */}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? '展开左栏' : '收起左栏'}
          style={{
            flex: 'none', width: 24, height: 24, display: 'grid', placeItems: 'center', padding: 0,
            border: 'none', borderRadius: 6, cursor: 'pointer',
            background: 'transparent', color: 'var(--color-text-dim)',
          }}
        >
          {collapsed ? '»' : '«'}
        </button>
        {!collapsed && (
          <span style={{ font: 'var(--dsw-font-xs-strong-13)', whiteSpace: 'nowrap' }}>会话</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: collapsed ? '0 16px' : '0 8px 8px' }}>
        {CONVERSATIONS.map(([title, when], index) => (
          <div
            key={title}
            style={collapsed ? {
              width: 24, height: 24, marginBottom: 8, borderRadius: 6,
              background: index === 0 ? 'var(--color-bg-active)' : 'var(--color-bg-hover)',
            } : {
              padding: '7px 8px', marginBottom: 2, borderRadius: 8, cursor: 'pointer',
              background: index === 0 ? 'var(--color-bg-hover)' : 'transparent',
            }}
          >
            {!collapsed && (
              <>
                <div style={{ font: 'var(--dsw-font-xs-13)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {title}
                </div>
                <div style={{ font: 'var(--dsw-font-xxs-12)', color: 'var(--color-text-dim)' }}>{when}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Main({ readout }: { readout: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', color: 'var(--color-text)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 24px 80px' }}>
        <h1 style={{ font: 'var(--dsw-font-markdown-h2)', margin: '0 0 12px' }}>中栏</h1>
        <p style={{ font: 'var(--dsw-font-markdown-base)', color: 'var(--color-text-dim)', margin: '0 0 16px' }}>
          中栏受 CENTER_MIN = 400 保护：只要右栏还占着轨道，它就不会低于 400；
          右栏的轨道一旦消失，它才被允许继续往下掉，一直到 0。把浏览器窗口慢慢拖窄，
          看底下那行读数里 rightbar 怎么先缩到 {RIGHTBAR_MIN}、再变成 0。
        </p>
        {Array.from({ length: 6 }, (_, i) => (
          <p key={i} style={{ font: 'var(--dsw-font-markdown-base)', margin: '0 0 16px' }}>
            第 {i + 1} 段假正文。这里只是给中栏一点能滚动的高度，好看清 `.centerCol` 的
            `overflow: hidden` + 内层自己滚这套结构有没有生效——外壳本身不滚，滚的是里面。
          </p>
        ))}
        {readout}
      </div>
    </div>
  );
}

/**
 * 右栏占位者。
 *
 * 它是**贴着框右边缘画的一块面板**，不是被栏「装」进去的：没有轨道时它从一条零宽的栏里
 * 探出来盖住中栏，有轨道时中栏让地。这正是 AppFrame.module.css 里 `.rightbarCol` 不裁剪
 * （`overflow: visible`）的原因，画出来才看得出区别——所以这一页给了「占轨」和「不占轨」
 * 两个按钮。
 */
function RightPanel({ shown, width, fullscreen, onClose }: {
  shown: boolean; width: number; fullscreen: boolean; onClose: () => void;
}) {
  if (!shown) return null;
  return (
    <div
      style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width, zIndex: 10,
        display: 'flex', flexDirection: 'column',
        background: 'var(--color-bg-panel)',
        borderLeft: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--color-text)',
      }}
    >
      <div style={{
        flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 44, padding: '0 8px 0 16px',
      }}>
        <span style={{ font: 'var(--dsw-font-xs-strong-13)' }}>右栏{fullscreen ? '（全屏）' : ''}</span>
        <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--color-text-dim)', cursor: 'pointer' }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 16px', font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)' }}>
        <p>实测宽度 {Math.round(width)}px。</p>
        <p>
          全屏态下外面那根拖拽把手会消失（上游的规矩：全屏仍然保留它报上来的轨道，
          但不让拖），退出全屏的那一帧还会压掉过渡——data-rightbar-instant。
        </p>
        {Array.from({ length: 12 }, (_, i) => <p key={i}>右栏假内容 {i + 1}。</p>)}
      </div>
    </div>
  );
}

type PanelMode = 'closed' | 'track' | 'overlay' | 'fullscreen';

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  const { layout, actions, geometry } = useLayoutState(PERSISTENCE);
  const [mode, setMode] = useState<PanelMode>('closed');

  /*
    右栏的呈现方式是**占位者报上来的**，不是框自己知道的（见 layout-state.ts 里
    rightbarShown 那段注释）。这个 effect 就是那份上报。
  */
  useEffect(() => {
    if (mode === 'closed') actions.closeRightbar();
    else actions.openRightbar(mode !== 'overlay', mode === 'fullscreen');
  }, [mode, actions]);

  const readout = useMemo(() => (
    <div style={{
      marginTop: 24, padding: 12, borderRadius: 10,
      border: '1px solid var(--color-border)', background: 'var(--color-bg-raised)',
      font: 'var(--dsw-font-markdown-code-block)', color: 'var(--color-text)', whiteSpace: 'pre-wrap',
    }}>
      {[
        `框宽 viewport   ${Math.round(layout.viewportWidth)}`,
        `左栏 sidebar    ${geometry.cols.sidebar}${geometry.sidebarCollapsed ? '（折叠轨）' : ''}`,
        `中栏 center     ${Math.round(geometry.cols.center)}`,
        `右栏 rightbar   ${Math.round(geometry.cols.rightbar)}（正常宽度 ${Math.round(geometry.normal.rightbar)}）`,
        `窄屏 narrow     ${String(geometry.narrow)}（断点 ${SIDEBAR_AUTO_COLLAPSE}）`,
        `存下来的偏好    sidebar=${String(layout.sidebar)} rightbar=${String(layout.rightbar)}`,
      ].join('\n')}
    </div>
  ), [layout, geometry]);

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--color-bg)', color: 'var(--color-text)',
    }}>
      <div style={{
        flex: 'none', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 10px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bar)', color: 'var(--color-bar-text)', fontSize: 12,
      }}>
        <button type="button" onClick={toggleTheme}>主题：{theme}</button>
        <button type="button" onClick={actions.toggleSidebar}>
          左栏：{geometry.sidebarCollapsed ? '折叠' : '展开'}
        </button>
        <button type="button" onClick={() => { setMode(m => (m === 'track' ? 'closed' : 'track')); }}>
          右栏占轨：{mode === 'track' ? '开' : '关'}
        </button>
        <button type="button" onClick={() => { setMode(m => (m === 'overlay' ? 'closed' : 'overlay')); }}>
          右栏不占轨（盖在中栏上）：{mode === 'overlay' ? '开' : '关'}
        </button>
        <button type="button" onClick={() => { setMode(m => (m === 'fullscreen' ? 'track' : 'fullscreen')); }}>
          全屏：{mode === 'fullscreen' ? '开' : '关'}
        </button>
        <button
          type="button"
          onClick={() => {
            try { localStorage.removeItem('roost-fixture-app-frame'); } catch { /* 无痕窗口 */ }
            location.reload();
          }}
        >
          忘掉存下来的布局并刷新
        </button>
        <span style={{ opacity: 0.7 }}>两条栏边可以拖；窗口拖到 {SIDEBAR_AUTO_COLLAPSE} 以下左栏自动折叠</span>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <AppFrame
          layout={layout}
          actions={actions}
          sidebar={<Sidebar collapsed={geometry.sidebarCollapsed} onToggle={actions.toggleSidebar} />}
          main={<Main readout={readout} />}
          rightbar={(
            <RightPanel
              shown={layout.rightbarShown}
              width={mode === 'fullscreen' ? layout.viewportWidth : geometry.normal.rightbar}
              fullscreen={layout.rightbarFullscreen}
              onClose={() => { setMode('closed'); }}
            />
          )}
          overlay={(
            /* 浮层层是 pointer-events: none，只有它的孩子能点——这颗吐司能点中就说明那条规则接上了。 */
            <div
              style={{
                position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)',
                padding: '8px 14px', borderRadius: 999, cursor: 'pointer',
                background: 'var(--color-bg-raised)', boxShadow: 'var(--dsw-elevation-panel)',
                font: 'var(--dsw-font-xs-13)', color: 'var(--color-text)',
              }}
              onClick={(e) => { e.currentTarget.style.opacity = '0.4'; }}
            >
              浮层层（点我：只有这颗能点中，它周围的整层是穿透的）
            </div>
          )}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
