// 隔离的浏览器 fixture：把 vendor/dsh/skeleton 的对话外壳画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-conversation-shell.html 就行。
//
// 为什么非画不可：这一整个壳全部的行为都在 CSS 里，而且都是 jsdom 量不出来的那种
// （clamp/calc/:has/sticky/container query 一概不算，getBoundingClientRect 恒为 0）。
// 更要紧的是 NOTICE.md 第 3 条记的那个模式——**上游那批 CSS 建立在上游自己的 reset 上，
// 搬到我们的 Tailwind preflight 上必然缺一块**，而且两次都是 typecheck 和测试看不出、
// 只有画出来才发现（`ol,ul{list-style:none}` 干掉列表标记、`svg{display:block}` 拆散
// 行内芯片）。所以这个 fixture 特意把**按钮、原生 select、contenteditable、<header>**
// 都摆出来——这几类是 preflight 动得最狠的。
//
// 要看的七件事（页面底部有实测读数，不用开 devtools）：
//   1. **76px 的头**——上游注释说这个数是对齐右栏的「标签条 38 + 窗格头 38」。
//   2. **内容宽度轴跟着栏宽走**——点「假侧栏」把栏挤窄，列宽和输入卡宽**同时**变，
//      而且输入卡永远比列宽正好 32px。这条以前在 Roost 里是死的：
//      `--dsh-conversation-column-width` 全仓没人发布过，clamp 恒等于下限 680px。
//   3. **sticky 输入座位在滚动容器里面**——鼠标停在输入卡上滚轮照样滚转录；
//      座位顶上那条 36px 的渐变遮罩让正文淡出而不是硬切。
//   4. **hero 空态**——输入卡居中，没有转录、没有拖条，卡片宽度和落位之后**一模一样**。
//   5. **settling**——座位 visibility:hidden 挂着，不是不渲染（切过去看草稿还在）。
//   6. **两条 40px 拖条**——hover 出一道跟着指针 Y 走的发光条，拖动对称改宽（往外 1px
//      宽 2px），松手落 localStorage；「清偏好」按钮把它擦掉。
//   7. **深浅两套主题**——每一条都要在两个主题下各看一遍。
import { StrictMode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import clsx from 'clsx';
import { ConversationShell } from '../../src/vendor/dsh/skeleton/ConversationShell';
import type { ConversationPhase } from '../../src/vendor/dsh/skeleton/ConversationShell';
import rootCss from '../../src/vendor/dsh/skeleton/ConversationRoot.module.css';
import heroCss from '../../src/vendor/dsh/skeleton/HeroShell.module.css';
import inputCss from '../../src/vendor/dsh/skeleton/InputBar.module.css';
import { ChatView, ChatFlowItem } from '../../src/vendor/dsh/chat/ChatView';
import { AssistantMarkdown, type AssistantBlock } from '../../src/vendor/dsh/chat/AssistantMarkdown';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// 这批 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

const LABELS = {
  markdown: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' },
  reasoning: { think: '思考', running: '思考中' },
  stopped: '已停止',
  unknownBlock: '未知块',
  jsonTruncated: (total: number) => `……共 ${String(total)} 字符`,
};

const LONG_ANSWER: readonly AssistantBlock[] = [
  {
    kind: 'text',
    text: '这段刻意写长，好看清**列宽封顶**之后行长是什么感觉：满宽的长行在宽屏上读起来要来回甩头，'
      + '而对话里助手的段落恰恰是最长的那种文本，所以上游给消息列封了顶——**封顶的是列，不是滚动容器**，'
      + '滚动条仍然贴着栏的右边缘。\n\n'
      + '列封在 `--dsh-chat-content-width`，输入卡封在 `--dsh-composer-card-max-width`，'
      + '后者恒等于前者 + 32px。两条都声明在 `.root` 上，所以它们**共用同一根轴**，'
      + '窄栏下一起缩，卡片和正文的关系不会变。\n\n'
      + '- 列表项在这里是为了验 Tailwind preflight 的 `ol, ul { list-style: none }`\n'
      + '- 圆点没了就是 markdown/MarkdownText.module.css 那条 `list-style-type: revert` 掉了\n',
  },
];

function Filler({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <ChatFlowItem key={i} flowKey={`filler-${String(i)}`} kind="assistant" turn={i + 2}>
          <AssistantMarkdown
            blocks={[{ kind: 'text', text: `第 ${String(i + 1)} 条占位消息——把转录撑高，好验证座位是不是真的 sticky（滚起来它不动），以及 36px 的遮罩把滚过去的正文淡掉。` }]}
            streaming={false}
            labels={LABELS}
          />
        </ChatFlowItem>
      ))}
    </>
  );
}

/** 假的头。用的是 ConversationRoot.module.css 自带的面包屑/标签页类名——它们在 Roost
 *  里当前空转，但摆出来正好把 `<button>` 交给 preflight 检验一遍。 */
function FakeHeader({ tab, onTab }: { tab: string; onTab: (id: string) => void }) {
  return (
    <>
      <div className={rootCss.titleRow}>
        <div className={rootCss.titleCluster}>
          <nav className={rootCss.crumbs} aria-label="会话层级">
            <span className={rootCss.crumbSeg}>
              <button type="button" className={rootCss.crumb}>roost</button>
            </span>
            <span className={rootCss.crumbSeg}>
              <span className={rootCss.crumbSep}>/</span>
              <button type="button" className={clsx(rootCss.crumb, rootCss.crumbCurrent)} disabled>
                搬对话列骨架
              </button>
            </span>
          </nav>
          <div className={rootCss.headerActions} />
        </div>
        <div className={rootCss.headerUtilities} />
        <div className={rootCss.headerCorner} data-conversation-header-corner="" />
      </div>
      <div className={rootCss.tabs} role="tablist">
        {['对话', '轨迹'].map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === tab}
            className={clsx(rootCss.tab, id === tab && rootCss.tabActive)}
            onClick={() => { onTab(id); }}
          >
            {id}
          </button>
        ))}
      </div>
    </>
  );
}

/** 假的输入卡。只用 InputBar.module.css 的类名结构，**故意不接**真正的
 *  `vendor/dsh/skeleton/InputBar`：那张卡自己的状态（空/长草稿/发送中/禁用、preflight
 *  对 textarea 和 button 的那几刀）在 `dsh-input-bar.tsx` 里逐个画过了，这一页要验的是
 *  **壳**——几何（22px 圆角、宽度封顶、336px 的滚动上限跟着座位走）以及 preflight 会不会
 *  把原生 select / contenteditable 弄坏。两页分开，改一页不会把另一页要验的东西挤掉。 */
function FakeInputBar({ hero, draft, onDraft }: {
  hero: boolean;
  draft: string;
  onDraft: (value: string) => void;
}) {
  return (
    <div className={clsx(inputCss.root, hero && inputCss.hero)}>
      <div className={inputCss.card}>
        <div className={inputCss.scroll}>
          <div className={inputCss.grow}>
            <div
              className={inputCss.input}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              tabIndex={0}
              onInput={e => { onDraft(e.currentTarget.textContent ?? ''); }}
            />
            {draft === '' && (
              <div className={inputCss.placeholder}>
                随便打点字，多打几行看草稿长高时座位跟不跟着长（上限 336px = 14 行）
              </div>
            )}
          </div>
        </div>
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <button type="button" className={inputCss.add} aria-label="附件">+</button>
          </div>
          <div className={inputCss.modes}>
            <select className={inputCss.select} defaultValue="plan" aria-label="模式">
              <option value="plan">计划</option>
              <option value="ro">只读</option>
            </select>
          </div>
          <div className={inputCss.trailing}>
            <select className={inputCss.select} defaultValue="opus" aria-label="模型">
              <option value="opus">claude-opus</option>
              <option value="codex">codex</option>
            </select>
            <button type="button" className={inputCss.primary} aria-label="发送">↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** hero 的居中栈：标题一行（上游是鲸鱼 + 标题，我们没有标记，只留标题组）+ 工作区芯片行。 */
function FakeHero() {
  return (
    <>
      <div className={heroCss.root}>
        <div className={heroCss.stack}>
          <div className={heroCss.headline}>
            <span className={heroCss.titleGroup}>
              <span>今天做点什么？</span>
              <span className={heroCss.previewBadge}>skeleton</span>
            </span>
          </div>
          <div className={heroCss.body} />
        </div>
      </div>
      <div className={rootCss.heroWorkspaceRow}>
        <button type="button" className={heroCss.workspace} aria-haspopup="menu" aria-expanded={false}>
          <span className={heroCss.workspaceLabel}>~/Code/roost</span>
          <span className={heroCss.chevron}>⌄</span>
        </button>
      </div>
    </>
  );
}

/** 实测读数。每一行对应上面注释里的一件事。 */
function Readouts({ tick }: { tick: number }) {
  const [lines, setLines] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    const read = () => {
      const root = document.querySelector<HTMLElement>('[data-phase]');
      if (root === null) return;
      const px = (name: string) => getComputedStyle(root).getPropertyValue(name).trim() || '（空）';
      const box = (sel: string) => document.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
      const header = root.querySelector('header');
      const scroll = root.querySelector<HTMLElement>('[data-conversation-scroll]');
      const seat = root.querySelector<HTMLElement>('[data-composer-seat]');
      const column = box('[data-chat-flow]');
      const card = document.querySelector<HTMLElement>(`.${inputCss.card.split(' ')[0]!}`)?.getBoundingClientRect();
      const handles = [...root.querySelectorAll<HTMLElement>('[data-width-handle]')];
      const round = (n: number | undefined) => n === undefined ? '—' : String(Math.round(n));
      setLines([
        `头高 ${header === null ? '（未渲染）' : `${round(header.getBoundingClientRect().height)}px`}`
          + `（上游定死 min-height: 76px = 右栏 38 + 38）`,
        `栏宽变量 --dsh-conversation-column-width = ${px('--dsh-conversation-column-width')}`
          + `，拖出来的偏好 --dsh-chat-user-width = ${px('--dsh-chat-user-width')}`,
        `消息列实测 ${round(column?.width)}px / 输入卡实测 ${round(card?.width)}px`
          + `（卡必须正好宽 32px：--dsh-composer-card-max-width = 列 + 32）`,
        `座位 position=${seat === null ? '—' : getComputedStyle(seat).position}`
          + `，实测高 ${round(seat?.getBoundingClientRect().height)}px`
          + `，发布到滚动容器上的 --dsh-composer-height = `
          + `${scroll === null ? '—' : getComputedStyle(scroll).getPropertyValue('--dsh-composer-height').trim() || '（空）'}`,
        `滚动容器 scrollbar-gutter=${scroll === null ? '—' : getComputedStyle(scroll).scrollbarGutter}`
          + `（必须是 stable：auto 会让输入卡随滚动条有无横向平移）`,
        `拖条 ${handles.length === 0 ? '（当前相位不渲染）' : handles.map(h =>
          `${h.dataset['side'] ?? '?'} ${round(h.getBoundingClientRect().width)}px`).join(' / ')}`,
      ]);
    };
    read();
    /*
      **必须跟着栏重算，不能只读一次。** 这一页要验的核心就是那段 ResizeObserver——
      它在首帧之后才把实测栏宽发布成 `--dsh-conversation-column-width`，而读数如果只在挂载时
      算一遍，看到的永远是发布之前的值（实测：显示成 1px，于是 `clamp` 看着像卡在 680px 下限，
      而真实的正文列已经是 819px = 0.64 × 1280）。那是个会骗人的读数——比没有读数更糟。

      用 ResizeObserver 而不是 `setTimeout(read, 0)`：后者试过，没兜住；而且假侧栏开关改的是
      栏宽、不是窗口宽，`resize` 事件根本不会触发。
    */
    const root = document.querySelector<HTMLElement>('[data-phase]');
    const observer = root === null || typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    if (root !== null) observer?.observe(root);
    window.addEventListener('resize', read);
    return () => { observer?.disconnect(); window.removeEventListener('resize', read); };
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
  const [phase, setPhase] = useState<ConversationPhase>('active');
  const [sidebar, setSidebar] = useState(false);
  const [tab, setTab] = useState('对话');
  const [draft, setDraft] = useState('');
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => { setTick(n => n + 1); }, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hero = phase === 'hero';
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
        <button type="button" onClick={() => { toggleTheme(); bump(); }}>主题：{theme}</button>
        {(['hero', 'active', 'settling'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => { setPhase(value); bump(); }}
            style={{ fontWeight: phase === value ? 700 : 400 }}
          >
            {value}
          </button>
        ))}
        <button type="button" onClick={() => { setSidebar(open => !open); bump(); }}>
          假侧栏：{sidebar ? '开（栏被挤窄）' : '关'}
        </button>
        <button type="button" onClick={() => { localStorage.removeItem('dsh.conversation.contentWidth'); location.reload(); }}>
          清掉拖出来的宽度偏好
        </button>
        <span style={{ opacity: 0.7 }}>拖条在正文左右各 40px 处，hover 才显形</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 假侧栏存在的唯一理由：证明宽度轴跟的是**栏宽**而不是窗口宽——不动窗口，
            只把栏挤窄，列宽和输入卡宽必须同时变。这正是那段 ResizeObserver 的意义。 */}
        {sidebar && (
          <div style={{
            flex: 'none', width: 320, borderRight: '1px solid var(--color-border)',
            background: 'var(--color-bg-panel)', padding: 10, fontSize: 12,
          }}>
            假侧栏（320px）
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ConversationShell
            phase={phase}
            scrollRef={scrollRef}
            header={hero ? null : <FakeHeader tab={tab} onTab={id => { setTab(id); bump(); }} />}
            composer={
              <>
                {hero && <FakeHero />}
                <FakeInputBar hero={hero} draft={draft} onDraft={value => { setDraft(value); bump(); }} />
              </>
            }
          >
            {hero ? null : (
              <ChatView onToBottom={() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }} toBottomLabel="回到底部">
                <ChatFlowItem flowKey="user-1" kind="user" turn={1}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{
                      maxWidth: '80%', padding: '6px 12px', borderRadius: 14,
                      background: 'var(--dsw-specific-bubble)', fontSize: 14, lineHeight: '22px',
                    }}>
                      把上游的对话列骨架搬进 vendor/dsh/skeleton
                    </div>
                  </div>
                </ChatFlowItem>
                <ChatFlowItem flowKey="answer-1" kind="assistant" turn={1}>
                  <AssistantMarkdown blocks={LONG_ANSWER} streaming={false} labels={LABELS} />
                </ChatFlowItem>
                <Filler n={12} />
              </ChatView>
            )}
          </ConversationShell>
        </div>
      </div>

      <Readouts tick={tick} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
