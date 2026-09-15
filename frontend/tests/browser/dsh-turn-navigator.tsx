// 隔离的浏览器 fixture：用假数据把 vendor/dsh/chat 的回合导轨画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-turn-navigator.html 就行。
//
// 导轨是纯 CSS 定位的浮层——刻度间距、活动刻度居中、预览卡的 clamp() 竖向定位，
// 没有一样能被 jsdom 单测钉住（jsdom 的 getBoundingClientRect 全是 0，也不算 calc）。
// 所以验证方式就是把它画出来看：
//   1. 一条十几格的刻度，间距均匀；
//   2. 当前回合那一格明显更长更亮；
//   3. 鼠标移上去弹预览卡，卡片竖向跟着那一格走。
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TurnNavigator, type TurnNavigatorItem } from '../../src/vendor/dsh/chat/TurnNavigator';
import { ThemeProvider } from '../../src/shared/theme';
// 导轨的 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。真正接进 features 的时候
// 由 vendor/dsh 的入口带进来，fixture 里单独引一次。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

const TURNS: readonly { prompt: string; response: string }[] = [
  { prompt: '帮我看看 xyz 解析器为什么少了原子', response: '空行的 `continue` 被改成了 `break`，第一处空行之后的原子全被丢掉了。' },
  { prompt: '那把 break 改回 continue', response: '改好了，parseXyz 的空行分支恢复成跳过。' },
  { prompt: '跑一下测试', response: '28 通过 1 失败：失败的是「空行兜底删掉之后」那条，它钉的是旧行为。' },
  { prompt: '这条用例是不是该跟着改', response: '是。它断言 3 !== 1，钉的正是被改坏的那版语义。' },
  { prompt: '改完再跑', response: '29 个用例全绿。' },
  { prompt: '顺手看下 atoms 为空的时候会怎样', response: '会抛 `xyz: 没有解析出任何原子`，调用方那边没有 catch。' },
  { prompt: '给它加个 catch', response: '在 loadMolecule 里包了一层，失败时回退到空结构并弹提示。' },
  { prompt: '提示文案走 i18n 吗', response: '走。加到 packages/i18n 的两份里了，中英各一条。' },
  { prompt: 'tsc 过了没', response: '过了。Widen 类型两边形状一致。' },
  { prompt: '再确认一下 count 字段有没有被别处用到', response: '只有 MoleculeStats 读，改成可选之后那边补了默认值 0。' },
  { prompt: '边界检查呢', response: 'check-boundaries 全绿，没有新的跨目录 import。' },
  { prompt: '把改动的文件列一下', response: 'parse-xyz.ts、load-molecule.ts、packages/i18n 两份、tests/parse-xyz.test.ts。' },
  { prompt: '还有别的解析器有同样的空行问题吗', response: 'grep 过 mol/pdb/sdf 三个，都用的 continue，没有同样的坑。' },
  { prompt: '好，那就这样', response: '收工。改动没有提交，工作区里等你看。' },
  { prompt: '等下，再帮我看眼 pdb 的列宽假设', response: 'PDB 是定宽格式，现在按空白切分，遇到负坐标粘连会切错——这是另一个 bug。' },
];

const ITEMS: readonly TurnNavigatorItem[] = TURNS.map((turn, index) => ({
  id: `turn-${String(index + 1)}`,
  label: `${String(index + 1)}. ${turn.prompt}`,
  detail: turn.response,
  // 最后两个画淡一档，看 muted 那条支路有没有接上。
  muted: index >= TURNS.length - 2,
}));

// 十几个回合的自然高度（15 格 ×10px）还没到导轨的高度上限，导轨不会溢出，
// 于是「两端渐隐 + 活动刻度自动居中」这条支路根本走不到。长会话把回合重复到 60 个，
// 专门用来看那一段：切过去时活动回合是第 52 个，它的刻度落在导轨可视范围之外，
// 导轨会自己滚过去（这里已经到底，所以是贴底而不是正中——上游的 Math.max(0, …) 本来就
// 只保证「进视野」）。只有上端还能再滚，于是只有上端渐隐。
const LONG_ITEMS: readonly TurnNavigatorItem[] = Array.from({ length: 60 }, (_, index) => ({
  id: `long-${String(index + 1)}`,
  label: `${String(index + 1)}. ${TURNS[index % TURNS.length]!.prompt}`,
  detail: TURNS[index % TURNS.length]!.response,
}));

function Fixture() {
  const [long, setLong] = useState(false);
  const items = long ? LONG_ITEMS : ITEMS;
  const [activeId, setActiveId] = useState<string | null>('turn-5');
  const activeIndex = items.findIndex(item => item.id === activeId);
  return (
    <div
      style={{
        // 导轨的 .slot 是 sticky + height:0，靠最近的定位祖先摆位置；这里就是那个「对话列」。
        position: 'relative',
        // .frame 的高度是 min(自然高度, 可视带 - 64px, 420px)，可视带来自这两个变量。
        ['--dsh-conversation-viewport-height' as string]: '640px',
        ['--dsh-composer-height' as string]: '96px',
        // 上游在 >900px 的容器里才显示导轨，所以这里必须是个真的 container。
        containerType: 'inline-size',
        width: 960,
        height: 640,
        margin: '40px auto',
        padding: '0 28px',
        boxSizing: 'border-box',
        overflowY: 'auto',
        background: 'var(--color-bg-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        color: 'var(--color-text)',
        font: 'var(--dsw-font-xs-13)',
      }}
    >
      <TurnNavigator items={items} activeId={activeId} onSelect={setActiveId} ariaLabel="回合导航" />
      <p style={{ color: 'var(--color-text-dim)', margin: '16px 0 12px' }}>
        当前：第 {activeIndex + 1} 个回合（{activeId}）。点右边导轨上的刻度换一个；鼠标悬停弹预览卡。
      </p>
      <button
        type="button"
        onClick={() => {
          const next = !long;
          setLong(next);
          setActiveId(next ? 'long-52' : 'turn-5');
        }}
        style={{
          margin: '0 0 24px', padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid var(--color-border)', background: 'var(--color-bg-raised)',
          color: 'var(--color-text)', font: 'var(--dsw-font-xxs-12)',
        }}
      >
        {long ? '← 回到 15 个回合' : '切到 60 个回合（看溢出滚动、两端渐隐、活动刻度自动居中）'}
      </button>
      {items.map((item, index) => (
        <div
          key={item.id}
          id={item.id}
          style={{
            margin: '0 0 20px',
            padding: 12,
            borderRadius: 10,
            background: index === activeIndex ? 'var(--color-bg-hover)' : 'var(--color-bg-raised)',
            outline: index === activeIndex ? '1px solid var(--color-text-dim)' : 'none',
          }}
        >
          <div style={{ font: 'var(--dsw-font-xs-strong-13)' }}>{item.label}</div>
          <div style={{ marginTop: 6, color: 'var(--color-text-dim)', font: 'var(--dsw-font-xxs-12)' }}>
            {item.detail}
          </div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
