// 隔离的浏览器 fixture：把 vendor/dsh/chat 的 MessageIconActions 用假数据画几种状态。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-message-actions.html 就行。
//
// 和 dsh-primitives 同一个用途：CSS Module 打包、tokens.css 的令牌映射、深色/浅色主题，
// 这三样任何一个断了画面当场露馅，而 tsc 看不出来。这里额外盯两件这个组件特有的事：
// 复制成功后那一秒的勾（`copied` 那一支渲染的是另一个图标），以及不传 onBranch 时
// 分支按钮整个不出现。
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageIconActions } from '../../src/vendor/dsh/chat/MessageIconActions.tsx';
import type { ClockTranslate } from '../../src/vendor/dsh/chat/message-chrome.ts';
import { ThemeProvider } from '../../src/shared/theme';
// tokens.css 平时由 vendor/dsh 的桶入口带进来；这个 fixture 只取 chat/ 下的文件，绕过了那个桶，
// 所以必须自己引一次——否则 --dsw-* 全空，整行无色。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

/* 日期模板：调用方给。真接线时这两条会从 @roost/i18n 里取。 */
const clockDate: ClockTranslate = (key, { y, m, d }) => (
  key === 'clock.ymd' ? `${y} 年 ${m} 月 ${d} 日` : `${m} 月 ${d} 日`
);

const labels = {
  copy: '复制',
  copied: '已复制',
  branch: '从这里分支',
  branchUnavailable: '这条消息不是对话末尾，无法分支',
  clockDate,
};

const NOW = Date.now();
const DAY = 86_400_000;

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '4px 0' }}>
      <span style={{
        width: 260, flex: 'none', font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)',
      }}>{title}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 8px' }}>{title}</h2>
      {children}
    </section>
  );
}

/*
  「复制后」这一格不另画一份假的勾，而是真去点组件自己的按钮——假的那种画法只能证明
  我会写一个勾，证明不了组件的 copied 分支接得上。挂载后立刻点一次；写剪贴板失败时
  组件按设计不切图标，截图里这一格就会和上一格一样，那本身也是结论。
*/
function AutoCopied({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (host === null) return;
    host.querySelector('button')?.click();
  }, [host]);
  return <div ref={setHost} data-fixture="auto-copied">{children}</div>;
}

function Fixture() {
  return (
    <div style={{ width: 760, margin: '0 auto', padding: 24, color: 'var(--color-text)' }}>
      <Section title="时刻在后（assistant 尾巴）">
        <Row title="今天 —— 只给 HH:mm">
          <MessageIconActions text="今天这条" time={NOW} clock="end" labels={labels} />
        </Row>
        <Row title="三天前 —— 月日 + 时刻">
          <MessageIconActions text="三天前那条" time={NOW - 3 * DAY} clock="end" labels={labels} />
        </Row>
        <Row title="去年 —— 年月日 + 时刻">
          <MessageIconActions text="去年那条" time={NOW - 400 * DAY} clock="end" labels={labels} />
        </Row>
        <Row title="没有 time —— 不画时刻">
          <MessageIconActions text="临时消息" clock="end" labels={labels} />
        </Row>
      </Section>

      <Section title="时刻在前（user 那一侧）">
        <Row title="clock=start，时刻靠左">
          <MessageIconActions text="用户说的话" time={NOW - DAY} clock="start" labels={labels} />
        </Row>
      </Section>

      <Section title="分支：有回调 / 没回调 / 有但不可用">
        <Row title="不传 onBranch —— 只剩复制一个按钮">
          <MessageIconActions text="没有分支入口" time={NOW} clock="end" labels={labels} />
        </Row>
        <Row title="传了 onBranch —— 复制 + 分支两个">
          <MessageIconActions
            text="有分支入口" time={NOW} clock="end" labels={labels}
            onBranch={() => { globalThis.console.log('branch'); }}
          />
        </Row>
        <Row title="branchUnavailable —— 分支淡掉、不可点">
          <MessageIconActions
            text="不可分支" time={NOW} clock="end" labels={labels} branchUnavailable
            onBranch={() => { globalThis.console.log('branch'); }}
          />
        </Row>
      </Section>

      <Section title="复制前 / 复制后">
        <Row title="复制前 —— 复制图标">
          <MessageIconActions text="复制我" time={NOW} clock="end" labels={labels} />
        </Row>
        <Row title="复制后 —— 勾（挂载即自动点一次）">
          <AutoCopied>
            <MessageIconActions text="复制我" time={NOW} clock="end" labels={labels} />
          </AutoCopied>
        </Row>
      </Section>

      <Section title="extraActions / usageAction 两个插槽">
        <Row title="中间和末尾各塞一块">
          <MessageIconActions
            text="带插槽" time={NOW} clock="end" labels={labels}
            onBranch={() => { globalThis.console.log('branch'); }}
            extraActions={<span style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)' }}>· 插槽 ·</span>}
            usageAction={<span style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)' }}>1.2k tok</span>}
          />
        </Row>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
