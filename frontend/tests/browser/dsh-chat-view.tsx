// 隔离的浏览器 fixture：用假条目把 vendor/dsh/chat 的对话容器画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-chat-view.html 就行。
//
// 这个容器全部的行为都在 CSS 里，而且都是 jsdom 量不出来的那种（getBoundingClientRect
// 恒为 0，calc/clamp/container query 一概不算），所以验证方式是画出来量。三条要看的：
//   1. **列居中封顶**——`.column` 是 max-width + margin:0 auto，滚动条仍然满铺；
//      窄窗时列跟着窗口缩，宽窗时停在 --dsh-chat-content-width。
//   2. **普通条目之间 16px**——而且中间夹一个 `hidden` 的条目时**仍然是 16px**，
//      不是 32px：间距规则写成 `:not([hidden]) ~ :not([hidden])` 就是为了这个。
//   3. **折叠的过程行和它的答复之间 8px**——答复那条挂 data-turn-process-answer，
//      把 --dsh-chat-flow-gap 压到 8px；把过程展开，它变回 16px。
// 页面底部有一条实测读数，直接显示这三个数字，不用开 devtools。
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView, ChatFlowItem } from '../../src/vendor/dsh/chat/ChatView';
import { AssistantMarkdown, type AssistantBlock } from '../../src/vendor/dsh/chat/AssistantMarkdown';
import { TurnProcessNodeView } from '../../src/vendor/dsh/chat/TurnProcessNodeView';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// 这批 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。真正接进 features 的时候
// 由 vendor/dsh 的入口带进来，fixture 里单独引一次。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

const LABELS = {
  markdown: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' },
  reasoning: { think: '思考', running: '思考中' },
  stopped: '已停止',
  unknownBlock: '未知块',
  jsonTruncated: (total: number) => `……共 ${String(total)} 字符`,
};

const FIRST_ANSWER: readonly AssistantBlock[] = [
  {
    kind: 'reasoning',
    text: '先看 parseXyz。原子数是从第二行读的，但循环里遇到空行就 break 了。\n'
      + '第一处空行之后的原子会全部丢掉，而 xyz 文件里空行是合法的分隔。',
  },
  {
    kind: 'text',
    text: '空行的 `continue` 被改成了 `break`，所以第一处空行之后的原子全被丢掉了。\n\n'
      + '这段文本刻意写长一点，好看清**列宽封顶**之后行长是什么感觉：满宽的长行在宽屏上'
      + '读起来要来回甩头，而对话里助手的段落恰恰是最长的那种文本，所以上游给消息列封了顶，'
      + '滚动条却仍然贴着窗口右边缘——封顶的是列，不是滚动容器。',
  },
];

const SECOND_ANSWER: readonly AssistantBlock[] = [
  {
    kind: 'text',
    text: '改好了：`parse-xyz.ts` 的空行分支恢复成跳过，测试从 28 通过 1 失败变成 29 全绿。',
  },
];

const TAIL_ANSWER: readonly AssistantBlock[] = [
  { kind: 'text', text: '收工。改动没有提交，工作区里等你看。' },
];

/** fixture 自带的用户气泡。上游的 MessageItem 这一路还没搬，这里只要一个占位的形状。 */
function UserMessage({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{
        maxWidth: '80%',
        padding: '6px 12px',
        borderRadius: 14,
        background: 'var(--color-bg-hover)',
        color: 'var(--color-text)',
        fontSize: 14,
        lineHeight: '22px',
        whiteSpace: 'pre-wrap',
      }}>{text}</div>
    </div>
  );
}

/** 量出来的三个几何数字，直接显示在页面上。 */
function Readouts({ tick }: { tick: number }) {
  const [lines, setLines] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    const read = () => {
      const column = document.querySelector<HTMLElement>('[data-chat-flow]');
      if (column === null) return;
      const scroll = column.parentElement!;
      const box = (key: string) => document
        .querySelector<HTMLElement>(`[data-chat-flow-key="${key}"]`)
        ?.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const scrollBox = scroll.getBoundingClientRect();
      const left = columnBox.left - scrollBox.left;
      const right = scrollBox.right - columnBox.right;
      const gap = (a: string, b: string) => {
        const top = box(a); const bottom = box(b);
        return top === undefined || bottom === undefined ? '—' : `${String(Math.round(bottom.top - top.bottom))}px`;
      };
      setLines([
        `列宽 ${String(Math.round(columnBox.width))}px / 滚动容器 ${String(Math.round(scrollBox.width))}px`
          + `，左右留白 ${String(Math.round(left))}px / ${String(Math.round(right))}px（居中封顶）`,
        `普通间距 user-2 → process：${gap('user-2', 'process')}`,
        `夹着 hidden 条目的间距 answer-2 → tail：${gap('answer-2', 'tail')}`,
        `折叠过程 → 答复：${gap('process', 'answer-1')}`,
      ]);
    };
    read();
    window.addEventListener('resize', read);
    return () => { window.removeEventListener('resize', read); };
  }, [tick]);
  return (
    <div style={{
      flex: 'none',
      borderTop: '1px solid var(--color-border)',
      background: 'var(--color-bar)',
      color: 'var(--color-bar-text)',
      padding: '6px 10px',
      font: '12px/18px var(--font-mono)',
    }}>
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  );
}

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  // 折叠/展开回合过程：关着的时候成员条目 hidden，答复挂 data-turn-process-answer（8px）；
  // 展开之后成员现身、属性撤掉，节奏回到 16px。
  const [processOpen, setProcessOpen] = useState(false);
  // 上游的 ConversationRoot 用 ResizeObserver 把列的实测宽度发布成
  // --dsh-conversation-column-width，列宽的 clamp 才有 64% 那一项可算。默认关着，
  // 关着时 clamp 落到 680px 下限——这样截图里的数字是确定的。
  const [adaptive, setAdaptive] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (!adaptive) { host.style.removeProperty('--dsh-conversation-column-width'); setTick(n => n + 1); return; }
    const observer = new ResizeObserver(([entry]) => {
      host.style.setProperty('--dsh-conversation-column-width', `${String(entry!.contentRect.width)}px`);
      setTick(n => n + 1);
    });
    observer.observe(host);
    return () => { observer.disconnect(); };
  }, [adaptive]);
  return (
    <div ref={hostRef} style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--color-bg)', color: 'var(--color-text)',
    }}>
      <div style={{
        flex: 'none', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 10px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bar)', color: 'var(--color-bar-text)', fontSize: 12,
      }}>
        <button type="button" onClick={toggleTheme}>主题：{theme}</button>
        <button type="button" onClick={() => { setProcessOpen(open => !open); setTick(n => n + 1); }}>
          回合过程：{processOpen ? '展开' : '折叠'}
        </button>
        <button type="button" onClick={() => { setAdaptive(value => !value); }}>
          列宽：{adaptive ? '自适应 64%' : '默认 680px 下限'}
        </button>
        <span style={{ opacity: 0.7 }}>Cmd+F 搜「定宽格式」能命中折叠起来的那条</span>
      </div>

      <ChatView onToBottom={() => { /* 只为把 .toBottomSlot / .toBottom 画出来 */ }} toBottomLabel="回到底部">
        <ChatFlowItem flowKey="user-1" kind="user" turn={1}>
          <UserMessage text="帮我看看 xyz 解析器为什么少了原子" />
        </ChatFlowItem>

        <ChatFlowItem flowKey="answer-0" kind="assistant" turn={1}>
          <AssistantMarkdown blocks={FIRST_ANSWER} streaming={false} labels={LABELS} />
        </ChatFlowItem>

        <ChatFlowItem flowKey="user-2" kind="user" turn={2}>
          <UserMessage text="那把 break 改回 continue，然后跑一下测试" />
        </ChatFlowItem>

        {/* 折叠的过程摘要行。它和下面那条答复在语义上是一件事，所以答复那条挂
            data-turn-process-answer，把它俩之间的 16px 收到 8px。 */}
        <ChatFlowItem flowKey="process" kind="turn-process" turn={2}>
          <TurnProcessNodeView
            label="3 次工具调用 · 2 条消息"
            open={processOpen}
            onToggle={open => { setProcessOpen(open); setTick(n => n + 1); }}
            toolCalls={3}
            messages={2}
          />
        </ChatFlowItem>

        {/* 过程的成员：折叠时 hidden="until-found"（零高度、不贡献间距、Cmd+F 仍搜得到）。 */}
        <ChatFlowItem
          flowKey="member-1" kind="tool-call" turn={2}
          processMember hidden={!processOpen} onReveal={() => { setProcessOpen(true); setTick(n => n + 1); }}
        >
          <div style={{
            padding: '6px 10px', borderRadius: 6,
            background: 'var(--color-bg-raised)', fontSize: 13, lineHeight: '20px',
          }}>
            <code>sed -i 's/break/continue/' parse-xyz.ts</code>
          </div>
        </ChatFlowItem>
        <ChatFlowItem
          flowKey="member-2" kind="tool-call" turn={2}
          processMember hidden={!processOpen} onReveal={() => { setProcessOpen(true); setTick(n => n + 1); }}
        >
          <div style={{
            padding: '6px 10px', borderRadius: 6,
            background: 'var(--color-bg-raised)', fontSize: 13, lineHeight: '20px',
          }}>
            <code>npm test — 29 通过 0 失败</code>
          </div>
        </ChatFlowItem>

        <ChatFlowItem flowKey="answer-1" kind="assistant" turn={2} processAnswer={!processOpen}>
          <AssistantMarkdown blocks={SECOND_ANSWER} streaming={false} labels={LABELS} />
        </ChatFlowItem>

        <ChatFlowItem flowKey="user-3" kind="user" turn={3}>
          <UserMessage text="还有别的解析器有同样的空行问题吗" />
        </ChatFlowItem>

        <ChatFlowItem flowKey="answer-2" kind="assistant" turn={3}>
          <AssistantMarkdown
            blocks={[{ kind: 'text', text: 'grep 过 mol/pdb/sdf 三个，都用的 continue，没有同样的坑。' }]}
            streaming={false}
            labels={LABELS}
          />
        </ChatFlowItem>

        {/* **常驻隐藏的一条**，专门验证「隐藏条目不贡献间距」：它夹在 answer-2 和 tail
            之间，而那两条之间量出来必须是 16px，不是 32px。 */}
        <ChatFlowItem flowKey="hidden-probe" kind="assistant" turn={3} hidden>
          <AssistantMarkdown
            blocks={[{ kind: 'text', text: 'PDB 是定宽格式，现在按空白切分，遇到负坐标粘连会切错。' }]}
            streaming={false}
            labels={LABELS}
          />
        </ChatFlowItem>

        <ChatFlowItem flowKey="tail" kind="assistant" turn={3}>
          <AssistantMarkdown blocks={TAIL_ANSWER} streaming={false} labels={LABELS} />
        </ChatFlowItem>
      </ChatView>

      <Readouts tick={tick} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
