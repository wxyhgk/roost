// 隔离的浏览器 fixture：把 features/conversations/MessageBody 的三种分派用假 Item 各画一遍。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-message-body.html 就行（5175 上是同一个路径）。
//
// 和 dsh-message-item 的分工：那一个盯的是 vendor 组件本身，这一个盯的是**接线之后**的
// 样子——MessageBody 选对了视图没有、气泡在我们自己的行容器里宽度对不对、tool 那一支
// 的原样底框和 line-clamp 有没有被换掉时丢掉。
//
// 为什么非画出来看不可：NOTICE 第 3 条记了两次 typecheck 和单测全绿、只有截图才发现的
// 事故（Tailwind preflight 的 `ol,ul{list-style:none}` 干掉列表标记、`svg{display:block}`
// 把引用芯片拆成两行）。这次接的正是第二次那个——`user-text.tsx` 的 `@文件` 芯片，
// 所以第二节必须逐字核对「图标和文字在同一行」。
//
// 右上角那颗钮切深浅；截图脚本直接改 documentElement.dataset.theme 也行，两条路同一个开关。
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBody } from '../../src/features/conversations/MessageBody.tsx';
import { messageView } from '../../src/features/conversations/message-view.ts';
import type { Item } from '../../src/features/conversations/parts.ts';
import type { HistoryMessage } from '../../src/shared/api/conversationPayloads.ts';
import { MarkdownText } from '../../src/vendor/dsh/markdown/MarkdownText.tsx';
import assistantCss from '../../src/vendor/dsh/chat/AssistantMarkdown.module.css';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// tokens.css 平时由 vendor/dsh 的桶入口带进来；这里只取单个文件，绕过了那个桶，所以自己引一次
// ——否则 --dsw-* 全空，气泡没底色。index.css 带的是 Tailwind（我们那批 bg-* / text-* 类）。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

const NOW = Date.now();

/** 假一条 HistoryMessage：MessageBody 只读 `event.createdAt`（进时刻）。 */
const fakeMessage = (id: string, createdAt = NOW): HistoryMessage => ({
  messageId: id, historySeq: 1, bodyState: 'stored', sourceRevision: 1,
  event: { role: 'user', createdAt },
});

const textItem = (key: string, role: string, text: string, createdAt = NOW): Extract<Item, { kind: 'text' }> => ({
  kind: 'text', key, role, text, message: fakeMessage(key, createdAt), turnStart: role === 'user',
});

/* 真接线时这一份在 ConversationDetail 里（还被压缩摘要共用）；fixture 自己拼一个同形的。 */
const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
const RENDER_PROSE = (value: string): ReactNode => (
  <div className={assistantCss.body}><MarkdownText text={value} labels={MARKDOWN_LABELS} /></div>
);

const LONG_USER_TEXT = [
  '把 deepseek-harness 的消息主体接上这件事，最怕的不是哪个组件画不出来，而是「看着画出来了」',
  '——CSS Module 的类名没接上、令牌桥少一条，页面照样渲染，只是无色、无边、无间距，而 tsc 全绿。',
  '这一段特意写长，为的是撑出气泡的换行和 max-width 封顶：气泡吃的是 --dsh-chat-content-width 的 ',
  '70.2%，换掉之前我们是写死的 max-w-[85%]，栏拖宽时它不跟着长、拖窄时又比上游宽一截。',
].join('');

const LONG_TOOL_TEXT = [
  '$ npm run build --workspace frontend',
  'vite v7.1.0 building for production...',
  'transforming...',
  '✓ 2841 modules transformed.',
  'dist/index.html                   0.62 kB │ gzip:  0.38 kB',
  'dist/assets/index-B7pQ2m1x.css  118.44 kB │ gzip: 17.92 kB',
  'dist/assets/index-DkY9v0Aa.js   386.31 kB │ gzip: 121.07 kB',
  '✓ built in 6.84s',
  '注意：这一段有 8 行以上，所以下面应该出现「展开全部 N 行」那颗钮，',
  '而收起时正文被 line-clamp-4 掐在第四行——这是上游没有对应视图、我们自己留着的那一支。',
].join('\n');

const ASSISTANT_TEXT = [
  '原因是 `npm run build` **只写 `frontend/dist`**，而 Caddy 服务的两个 root 都在',
  '`~/.local/share/roost/` 下。构建把 `index.html` 换成指向新哈希的版本，那些哈希要等发布才到位。',
  '',
  '发布的顺序和直觉相反：',
  '',
  '1. 资产先——只增不删，旧外壳引的哈希还在',
  '2. 外壳后——没有哈希、每次构建都可能变、必须替换',
  '',
  '| 组合 | 结果 |',
  '| --- | --- |',
  '| 旧外壳 + 新资产 | 好的 |',
  '| 新外壳 + 旧资产 | 入口脚本 404、页面纯白 |',
  '',
  '- 列表的圆点必须看得见（Tailwind preflight 把它清零过，NOTICE 第 3 条）',
  '- 有序列表的序号同理',
].join('\n');

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 10px' }}>
        {title}
        {note !== undefined && <span style={{ opacity: 0.7 }}>　—— {note}</span>}
      </h2>
      {children}
    </section>
  );
}

/*
  接线之后 ConversationDetail 里那一层行容器，**照提议的样子复刻**：`items-stretch`，
  头那一行自己 self-end / self-start。

  这一条是这张图要验的重点。原来是 `items-end`：`.userRow` 会被压成 fit-content，而
  `.userStack` 的 `max-width: min(…, 82%)` 里那个百分比就没有确定的参照——气泡宽度跟着
  内容走，0.702 那一档等于没接。改成 stretch 之后 `.userRow` 占满列宽，右对齐由它自己的
  `align-items: flex-end` 负责，和上游一致。
*/
function Row({ item, children }: { item: Extract<Item, { kind: 'text' }>; children: ReactNode }) {
  const mine = messageView(item.role) === 'bubble';
  return (
    <div className={`flex flex-col items-stretch gap-1 ${item.turnStart ? 'mt-3 border-t border-border/40 pt-3' : ''}`}>
      <div className={`flex items-center gap-2 text-caption text-text-dim ${mine ? 'self-end' : 'self-start'}`}>
        <span>{mine ? '你' : item.role === 'tool' ? '工具' : 'AI'}</span>
      </div>
      {children}
    </div>
  );
}

function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button" onClick={toggleTheme} data-fixture="theme-switch"
      style={{
        position: 'fixed', top: 12, right: 16, zIndex: 10, padding: '4px 10px', borderRadius: 6,
        border: '1px solid var(--color-border)', background: 'var(--color-bg-panel)',
        color: 'var(--color-text)', font: 'var(--dsw-font-xs-13)', cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? '切到浅色' : '切到深色'}
    </button>
  );
}

const ITEMS: { title: string; note: string; item: Extract<Item, { kind: 'text' }> }[] = [
  {
    title: '一、用户短消息',
    note: 'messageView("user") = bubble；气泡按内容收窄，底色 --dsw-specific-bubble',
    item: textItem('m1', 'user', '帮我看看 build 为什么把线上页面弄白了'),
  },
  {
    title: '二、用户消息里的 @路径 引用芯片',
    note: '图标和文字必须在同一行——preflight 的 svg{display:block} 就是在这里翻的车',
    item: textItem('m2', 'user',
      '照 @[昨天那次排查](dsh-session:abc123) 的结论改 @deploy/publish.mjs ，'
      + '再顺手看一眼 @frontend/src/features/conversations/ 这个目录。'
      + '**这几个星号不该被解析成粗体**，用户说的话不走 markdown。'),
  },
  {
    title: '三、用户长消息',
    note: '换行 + max-width 封顶（760 × 0.702 ≈ 534px），不再是写死的 85%',
    item: textItem('m3', 'user', LONG_USER_TEXT),
  },
  {
    title: '四、助手正文',
    note: 'messageView("assistant") = prose；不套气泡、走 MarkdownText（列表标记、表格都要在）',
    item: textItem('m4', 'assistant', ASSISTANT_TEXT, NOW - 86_400_000),
  },
  {
    title: '五、tool 那一支',
    note: 'messageView("tool") = mono；原样底框 + line-clamp-4 折叠，上游没有对应视图',
    item: textItem('m5', 'tool', LONG_TOOL_TEXT),
  },
  {
    title: '六、tool 的短文本',
    note: '没到折叠门槛就不出那颗钮',
    item: textItem('m6', 'tool', 'exit 0'),
  },
  {
    title: '七、认不出来的角色',
    note: 'system 落到 prose，而不是顶着「你」的样子跑到右边去',
    item: textItem('m7', 'system', '（这条的 role 是 `system`，画成正文。）'),
  },
];

function Fixture() {
  return (
    <div style={{
      /*
        直接钉**派生**的那一根轴，而不是钉栏宽。

        真接线时是 `ConversationShell` 的 ResizeObserver 发布 `--dsh-conversation-column-width`，
        再由 `ConversationRoot.module.css` 的 `.root` **在同一个元素上**算出
        `--dsh-chat-content-width = clamp(680px, 栏宽 × 0.64, 920px)`。

        fixture 里只在这个 div 上设栏宽是**没用的**（实测过）：tokens.css 那份兜底的
        `--dsh-chat-content-width` 声明在 `:root` 上，那里读到的栏宽是兜底的 0px，算出来
        恒等于 clamp 的下限 680px，再继承下来——设在后代身上已经晚了。所以这里钉派生值本身。
      */
      ['--dsh-chat-content-width' as string]: '760px',
      width: 760, margin: '0 auto', padding: '24px 24px 80px', color: 'var(--color-text)',
    }}>
      <ThemeSwitch />
      {ITEMS.map(({ title, note, item }) => (
        <Section key={item.key} title={title} note={note}>
          <Row item={item}><MessageBody item={item} renderBody={RENDER_PROSE} /></Row>
        </Section>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
