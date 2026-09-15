// 隔离的浏览器 fixture：把 vendor/dsh/chat 里那三块——压缩标记行、通用命令卡、
// `/compact` 命令卡——用假数据各画一遍。**不连后端**，`npm run dev --prefix frontend`
// 之后开 http://localhost:5173/tests/browser/dsh-command-cards.html 就行。
//
// 和 dsh-primitives.html 同一个用途：看 CSS Module 打包、tokens.css 的令牌映射、
// 深色/浅色主题这三样有没有接上。这三样任何一个断了，画面当场就是裸 DOM 或者一片无色。
// 这一页尤其要看压缩标记行——它的 CSS 是从上游 387 行的 MessageItem.module.css 里
// 抽出来的 20 条规则（见 vendor/dsh/chat/CompactionItem.module.css 的文件头），
// 抽漏了一条就是这里露馅。
import { StrictMode, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { CompactionItem } from '../../src/vendor/dsh/chat/CompactionItem.tsx';
import { GenericCommandCard } from '../../src/vendor/dsh/chat/GenericCommandCard.tsx';
import { CompactionCommandCard } from '../../src/vendor/dsh/chat/CompactionCommandCard.tsx';
// chat/ 下的文件不在 vendor/dsh 的桶里，直接 import 不会带上令牌表——真实调用方
// （ConversationDetail）是顺手从桶里取 ReasoningRow 才捎上的。这里显式引一次。
import '../../src/vendor/dsh/tokens.css';
import { ThemeProvider } from '../../src/shared/theme';
import '../../src/index.css';

const SUMMARY = `这次会话到目前为止做了三件事：

1. 把 xyz 解析器里「空行当终止符」的兜底删掉了，改成跳过空行继续读。回归用例在
   frontend/tests/parse-xyz.test.ts，三个原子的样例现在解析出 3 个而不是 1 个。
2. 顺带发现 ConversationDetail 里的思考块和正文混在一条流里，拆成了独立的折叠行。
3. 终端侧没有改动；PTY 还是活在 com.roost.terminal 那一个进程里。

未决的：命令卡还没有数据源，斜杠命令目前不解析。`;

const COMMAND_OUTPUT = `Compacted 42 messages into a checkpoint.
  kept: 8 messages (most recent turn)
  dropped: 34 messages (~18.2k tokens)
  summary: 1.4k tokens`;

const ROW_LABELS = { running: '运行中', failed: '失败' };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 8px' }}>{title}</h2>
      {children}
    </section>
  );
}

/*
  这几块都自己管展开状态，没有 defaultOpen 这种 prop（上游就没有，我们没加）。
  fixture 要画「展开」那一种，只能替读者点一下。

  用 ref 挡住第二次，不是查 aria-expanded：StrictMode 下 effect 会跑两遍，而两遍之间
  DOM 还没更新，查属性查到的仍是 'false'，于是开了又关，截出来还是收起的那张。
  选择器要连 `[role="button"]` 一起收：命令卡的展开目标是 DisclosureRow 那个整行的
  div（expandOnRowClick），不是 <button>。
*/
function ClickToExpand({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (clicked.current) return;
    clicked.current = true;
    ref.current?.querySelector<HTMLElement>('button[aria-expanded], [role="button"][aria-expanded]')?.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

function Fixture() {
  return (
    <div style={{ width: 760, margin: '0 auto', padding: 24, color: 'var(--color-text)' }}>
      <Section title="CompactionItem —— 收起（鼠标移上去，左边的图标会换成展开箭头）">
        <CompactionItem summary={SUMMARY} title="上下文已压缩" detail="压缩了 42 条消息 · 约 18.2k tokens" />
      </Section>

      <Section title="CompactionItem —— 展开（正文是那段摘要；上面被遮蔽的消息照常显示，这行只是分隔）">
        <ClickToExpand>
          <CompactionItem summary={SUMMARY} title="上下文已压缩" detail="压缩了 42 条消息 · 约 18.2k tokens" />
        </ClickToExpand>
      </Section>

      <Section title="CompactionItem —— 当前窗口里没带摘要：整行 disabled，点不开">
        <CompactionItem summary={null} title="上下文已压缩" detail="这段摘要不在当前窗口里" />
      </Section>

      <Section title="GenericCommandCard —— 运行中（行上有一道来回扫的高光）">
        <GenericCommandCard title="/compact" state="running" summary="正在压缩上下文…" labels={ROW_LABELS} />
      </Section>

      <Section title="GenericCommandCard —— 单行结算：文本已经在右边那句里，所以不给展开">
        <GenericCommandCard title="/model" state="ok" summary="已切换到 claude-opus-4" text="已切换到 claude-opus-4" labels={ROW_LABELS} />
      </Section>

      <Section title="GenericCommandCard —— 多行结算：可展开，正文是等宽的整段（这一条自动点开了）">
        <ClickToExpand>
          <GenericCommandCard title="/compact" state="ok" summary="压缩了 42 条消息" text={COMMAND_OUTPUT} labels={ROW_LABELS} />
        </ClickToExpand>
      </Section>

      <Section title="GenericCommandCard —— 失败：图标换成红点，右边那句和正文都转红">
        <GenericCommandCard
          title="/compact" state="error" summary="压缩失败：上游返回 429"
          text={'compaction failed: 429 Too Many Requests\n  retry-after: 31s'} labels={ROW_LABELS}
        />
      </Section>

      <Section title="CompactionCommandCard —— 有检查点：画成压缩标记行，不再重复一遍命令卡">
        <CompactionCommandCard
          compaction={{ summary: SUMMARY, title: '/compact', detail: '压缩了 42 条消息 · 约 18.2k tokens' }}
          command={{ title: '/compact', state: 'ok', summary: '压缩了 42 条消息', labels: ROW_LABELS }}
        />
      </Section>

      <Section title="CompactionCommandCard —— 没留下检查点：退回通用命令卡，保留完整结算文本">
        <CompactionCommandCard
          command={{
            title: '/compact', state: 'error', summary: '压缩失败：上游返回 429',
            text: 'compaction failed: 429 Too Many Requests\n  retry-after: 31s', labels: ROW_LABELS,
          }}
        />
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
