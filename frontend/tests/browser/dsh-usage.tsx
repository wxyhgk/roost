// 隔离的浏览器 fixture：把 vendor/dsh/chat 的回合用量 / 回合耗时两个药丸和它们的弹层画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-usage.html 就行。
//
// 为什么非得画出来：这里有三样 tsc 和单测都看不见的东西。
//   1. 弹层是 portal 到 document.body 的 position: fixed 面，位置由 stat-dialog.ts 算
//      （我们用 @floating-ui 重写的那一段）。jsdom 的 getBoundingClientRect 全是 0，
//      单测里它永远落在左上角。
//   2. 两个药丸的 svg。NOTICE.md 记了那条模式：Tailwind 的 preflight 把 svg 设成
//      display: block，上游的 CSS 不提这一条（它只要浏览器默认的 inline），
//      于是图标会被顶到文字上面一行。这一条只有画出来才看得见。
//   3. `--dsw-specific-menu` / `--dsw-elevation-prominent` 是这次新加进 tokens.css 的两个
//      令牌，缺了弹层就是一块透明的、没有边界的浮字。
//
// 数字全部是本机实测的量级（28 份 transcript / 5219 条 assistant 记录扫出来的）：
// 未命中输入是个位数、缓存读动辄几十万、输出几百到几千、单条最大总量 968403。
// 这不是凑的——用量面板最容易出洋相的地方就是「设计时按三位数排版，真数据是七位数」。
//
// 右上角那颗钮切深浅；截图脚本直接改 documentElement.dataset.theme 也行，两条路同一个开关。
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  TurnUsagePanel, TurnTimePanel,
  type TurnStatTranslate, type TurnTokenUsage,
} from '../../src/vendor/dsh/chat/TurnUsagePanel.tsx';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// tokens.css 平时由 vendor/dsh 的桶入口带进来；这个 fixture 只取 chat/ 下的文件，绕过了那个桶，
// 所以必须自己引一次——否则 --dsw-* 全空，药丸没颜色、弹层没有底。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

/* 真接线时这一整组从 @roost/i18n 取；这里写死中文。 */
const t: TurnStatTranslate = (key, params = {}) => {
  const p = params as Record<string, string | number | undefined>;
  switch (key) {
    case 'message.turnUsage.count': return `${String(p.count)} token`;
    case 'message.turnUsage.consumed': return `消耗 ${String(p.total)}`;
    case 'message.turnUsage.title': return '回合用量';
    case 'message.turnUsage.model': return '模型';
    case 'message.turnUsage.cacheHit': return '缓存命中';
    case 'message.turnUsage.input': return '输入';
    case 'message.turnUsage.cacheRead': return '缓存读取';
    case 'message.turnUsage.cacheWrite': return '缓存写入';
    case 'message.turnUsage.output': return '输出';
    case 'message.turnUsage.reasoning': return `（含思考 ${String(p.tokens)}）`;
    case 'message.ranFor': return `用时 ${String(p.duration)}`;
    case 'message.tokensPerSecond': return `${String(p.tps)} token/s`;
    case 'message.turnTime.title': return '回合耗时';
    case 'message.turnTime.duration': return '总时长';
    case 'message.turnTime.speed': return '解码速度';
    case 'message.turnTime.ttft': return '首字延迟';
    // 紧凑格式的单位。中文界面这里本该是「万」「亿」，但 formatTokens 的分档是 1e3/1e6，
    // 换算档位得连函数一起改——那是接线时的决定，fixture 先照上游的分档走。
    case 'number.thousand': return `${String(p.value)}K`;
    case 'number.million': return `${String(p.value)}M`;
    case 'number.groupSeparator': return ',';
    case 'duration.seconds': return `${String(p.seconds)} 秒`;
    case 'duration.minutes': return `${String(p.minutes)} 分 ${String(p.seconds)} 秒`;
    case 'duration.hours': return `${String(p.hours)} 时 ${String(p.minutes)} 分 ${String(p.seconds)} 秒`;
  }
};

/*
  回合用量是把这个回合里每条 assistant 消息的 MessageUsage 折起来的结果，所以 fixture 也照
  这条路走一遍——直接手写一个 TurnTokenUsage 会把「桶不全就整个不给」这条规矩绕过去，
  而那正是最值得画出来看的一条。

  `total` 是四项相加：未命中输入 + 缓存读 + 缓存写 + 输出。`reasoning` 是 output 的子集，不另加。
*/
type MessageUsage = {
  inputTokens: number; outputTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; model?: string;
};

function foldTurn(messages: readonly MessageUsage[]): TurnTokenUsage {
  const sum = (pick: (u: MessageUsage) => number | undefined) =>
    // 只要有一条缺这个桶，整个回合的这个桶就不给——不是当 0 加进去。
    messages.every(m => pick(m) !== undefined) ? messages.reduce((n, m) => n + pick(m)!, 0) : undefined;
  const uncachedInputTokens = messages.reduce((n, m) => n + m.inputTokens, 0);
  const outputTokens = messages.reduce((n, m) => n + m.outputTokens, 0);
  const cacheReadTokens = sum(m => m.cacheReadTokens);
  const cacheWriteTokens = sum(m => m.cacheWriteTokens);
  const models = [...new Set(messages.map(m => m.model))];
  return {
    uncachedInputTokens, outputTokens,
    totalTokens: uncachedInputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(sum(m => m.reasoningTokens) !== undefined ? { reasoningTokens: sum(m => m.reasoningTokens)! } : {}),
    ...(models.every(m => m !== undefined)
      ? { routes: (models as string[]).map(model => ({ provider: 'claude', model })) }
      : {}),
  };
}

const opus = 'claude-opus-5';

/* 典型回合：一问、三次工具、一答。缓存基本全命中（本机最常见的形态）。 */
const TYPICAL = foldTurn([
  { inputTokens: 2, outputTokens: 423, cacheReadTokens: 30516, cacheWriteTokens: 8246, reasoningTokens: 69, model: opus },
  { inputTokens: 1, outputTokens: 118, cacheReadTokens: 38764, cacheWriteTokens: 0, reasoningTokens: 0, model: opus },
  { inputTokens: 2, outputTokens: 871, cacheReadTokens: 39012, cacheWriteTokens: 1204, reasoningTokens: 240, model: opus },
]);

/* 冷启动：第一条请求什么都没命中，缓存读是真的 0——「0%」和「没有这一行」不是一回事。 */
const COLD = foldTurn([
  { inputTokens: 18432, outputTokens: 256, cacheReadTokens: 0, cacheWriteTokens: 18402, reasoningTokens: 0, model: opus },
]);

/* 桶缺席：这个回合里有一条消息没上报缓存和思考（本机 5219 条里有 12 条思考桶缺席）。
   缓存读写两行和命中率行应当整个消失，而不是显示 0。 */
const PARTIAL = foldTurn([
  { inputTokens: 2, outputTokens: 512, cacheReadTokens: 30516, cacheWriteTokens: 8246, reasoningTokens: 69, model: opus },
  { inputTokens: 4, outputTokens: 96, model: opus },
]);

/* 长会话尾巴：本机实测单条记录的总量最大 968403，一个回合里十几条摞起来就是几百万。
   药丸上是紧凑格式（3.8M），弹层里是精确数（带千分位）。 */
const HUGE = foldTurn(Array.from({ length: 4 }, () => ({
  inputTokens: 2, outputTokens: 7594, cacheReadTokens: 965950, cacheWriteTokens: 910695,
  reasoningTokens: 6676, model: opus,
})));

/* 两个模型路由：接线之后子 agent 换模型就会这样，`routes` 那一行要撑得住。 */
const MIXED = foldTurn([
  { inputTokens: 2, outputTokens: 423, cacheReadTokens: 30516, cacheWriteTokens: 8246, reasoningTokens: 69, model: opus },
  { inputTokens: 5, outputTokens: 210, cacheReadTokens: 12000, cacheWriteTokens: 300, reasoningTokens: 0, model: 'claude-haiku-4-5' },
]);

function Case({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section style={{ margin: '0 0 28px' }}>
      <h2 style={{ margin: '0 0 2px', font: 'var(--dsw-font-xs-strong-13)' }}>{title}</h2>
      <p style={{ margin: '0 0 6px', color: 'var(--color-text-dim)', font: 'var(--dsw-font-xxs-12)' }}>{note}</p>
      {/*
        回合尾那一行的近似：药丸右对齐坐在一条细线下面。真接线时这是 TurnTailNodeView
        的 IconActions 行，这里只要一个同样宽度、同样对齐的壳，好看出药丸在窄列里
        会不会把标签截成省略号。
      */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
        padding: '6px 4px 0', borderTop: '1px solid var(--color-border)',
      }}>
        {children}
      </div>
    </section>
  );
}

function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      data-fixture="theme-switch"
      style={{
        position: 'fixed', top: 12, right: 16, zIndex: 10,
        padding: '4px 10px', borderRadius: 6,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-panel)', color: 'var(--color-text)',
        font: 'var(--dsw-font-xs-13)', cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? '切到浅色' : '切到深色'}
    </button>
  );
}

function Fixture() {
  return (
    <div style={{
      width: 760, margin: '0 auto', padding: '24px 24px 420px', color: 'var(--color-text)',
      font: 'var(--dsw-font-xs-13)',
    }}>
      <ThemeSwitch />
      <h1 style={{ margin: '0 0 4px', font: 'var(--dsw-font-markdown-h3)' }}>回合用量 / 回合耗时</h1>
      <p style={{ margin: '0 0 24px', color: 'var(--color-text-dim)', font: 'var(--dsw-font-xxs-12)' }}>
        点药丸开弹层；再点一次、点外面、按 Esc 都能关。数值取自本机 transcript 的真实量级。
      </p>

      <Case title="典型回合（缓存几乎全命中）" note="三条 assistant 消息折起来：命中率 99.x%，弹层里六行俱全。">
        <TurnUsagePanel usage={TYPICAL} t={t} />
        {/* 短耗时：8.3 秒，走 duration.seconds 那一档。TTFT 和吞吐我们拿不到，留空——
            transcript 里没有首 token 时刻，用两条消息的落盘时刻差去伪造它是撒谎。 */}
        <TurnTimePanel runMs={8_300} t={t} />
      </Case>

      <Case title="冷启动（一次缓存也没命中）" note="缓存读是真的 0，所以命中率显示 0%——这一行在，只是值为零。">
        <TurnUsagePanel usage={COLD} t={t} />
        <TurnTimePanel runMs={23_800} t={t} />
      </Case>

      <Case title="桶不全（有一条消息没上报缓存和思考）" note="缓存读取 / 缓存写入 / 缓存命中三行整个消失，不是显示 0——「没报」和「是 0」是两件事。">
        <TurnUsagePanel usage={PARTIAL} t={t} />
        {/* 长耗时：1 小时 5 分 3 秒，走 duration.hours 那一档，小单位补零。 */}
        <TurnTimePanel runMs={3_903_000} t={t} />
      </Case>

      <Case title="数值很大（百万级）" note="药丸上是紧凑格式 7.5M，弹层里是带千分位的精确数——两种格式同时在场。">
        <TurnUsagePanel usage={HUGE} t={t} />
        <TurnTimePanel runMs={742_000} t={t} />
      </Case>

      <Case title="两个模型路由" note="routes 那一行会换行（.route 的 overflow-wrap: anywhere），不会把弹层撑宽。">
        <TurnUsagePanel usage={MIXED} t={t} />
        <TurnTimePanel runMs={45_600} t={t} />
      </Case>

      {/* 上游在 ≤480px 的视口下把药丸收成光图标（标签 display: none），文字退到弹层里。
          那是媒体查询，不是容器查询——所以这里只能靠缩窗口验证，摆一条说明提醒别误判。 */}
      <p style={{ marginTop: 32, color: 'var(--color-text-dim)', font: 'var(--dsw-font-xxs-12)' }}>
        窗口窄到 480px 以下时，两个药丸会收成光图标（上游的媒体查询），文字只留在弹层里。
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
