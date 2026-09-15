// 隔离的浏览器 fixture：把 vendor/dsh/skeleton 的输入卡（InputBar）画出来。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-input-bar.html 就行。
//
// 为什么非画不可：**这是唯一能发现 Tailwind preflight 撞车的手段**。NOTICE.md 第 3 条
// 记了两次这样的事故（`ol,ul{list-style:none}` 干掉 markdown 的列表标记、
// `svg{display:block}` 把引用芯片拆成两行），两次都是 typecheck 和单测全绿、只有画出来
// 才发现。这张卡正好踩在 preflight 动得最狠的两类元素上：
//
//   - `<textarea>`：preflight 有 `textarea { resize: vertical }`（右下角会长出一个能把
//     胶囊拽变形的把手）、`font: inherit`、`background-color: transparent`、
//     `border: 0 solid`、`margin/padding: 0`。InputBar 靠三条内联样式压住其中两条，
//     **下面的读数逐条验**：`resize` 必须是 none，`overflow-y` 必须是 hidden。
//   - `<button>`：preflight 会清掉背景和边框。`.add` / `.primary` 自己写了 background，
//     读数里把发送钮的实测背景色和圆角也打出来——变成透明或方角就是撞上了。
//
// 要看的六件事：
//   1. **22px 圆角的胶囊**、`--dsh-composer-card-max-width` 封顶、右下角 34px 的发送圆钮。
//   2. **草稿区跟着内容长高**，到 14 行（336px = 14 × 24）封顶改为滚动——
//      `.scroll` 是唯一会滚的盒子，textarea 自己不许滚（否则卡片里套两个滚动条）。
//   3. **发送中**：输入只读、发送钮失效、aria-label 换成「提交中…」。
//   4. **禁用态**：`.inputDisabled` 的灰 + `aria-disabled`，发送钮也失效。
//   5. **横幅**：上游走 Toast，我们落在 `.notice` 上（Toast 没搬）。超限那一档同时把
//      发送闸门关掉，但输入还能删字——这是 InputBar 的 `sendBlocked`。
//   6. **深浅两套主题**——每一条都要在两个主题下各看一遍。
//
// 「喂不满就不画」验的是**没有**什么：`+` 圆钮（斜杠/`@` 菜单）、模式芯片、模型选择、
// 附件轨在这一页上应当一个都看不见——最后一张卡故意把这些座位都喂上假内容，用来证明
// 它们只是没传，不是画不出来。
import { StrictMode, useCallback, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { InputBar } from '../../src/vendor/dsh/skeleton/InputBar';
import inputCss from '../../src/vendor/dsh/skeleton/InputBar.module.css';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// 这批 module.css 只认 --dsw-*，少了这张桥接表就是一片无色。
import '../../src/vendor/dsh/tokens.css';
// **必须引**：preflight 就在这里面。少了它这一页画得好看，线上照样坏。
import '../../src/index.css';

const PLACEHOLDER = '发消息给这个对话的 CLI…';
const ONE_LINE = '把上游的输入卡搬过来并接上';
/** 20 行——比 14 行的封顶多 6 行，好看清 `.scroll` 到底封没封住。 */
const MANY_LINES = Array.from({ length: 20 }, (_, i) => `第 ${String(i + 1)} 行：草稿长到这里就该滚了`).join('\n');

/**
 * 一张卡 + 它的说明。
 *
 * 那三个 CSS 变量在真实应用里是**壳**发布的：`--dsh-composer-card-max-width` 和
 * `--dsh-composer-side-clearance` 在 `ConversationRoot.module.css` 的 `.root` 上，
 * `--dsh-composer-text-max-height` 在 `.composerSeat` 上（也就是说草稿区的高度上限是
 * **座位**给的，不是卡片自己定的）。这一页没有壳，所以在这里原值摆出来。
 */
function Case({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ font: '12px/18px var(--font-mono)', opacity: 0.75 }}>
        {title}
        {note !== undefined && <span style={{ opacity: 0.7 }}>　{note}</span>}
      </div>
      <div
        data-case={title}
        style={{
          '--dsh-composer-card-max-width': '851px',
          '--dsh-composer-side-clearance': '16px',
          '--dsh-composer-text-max-height': '336px',
          background: 'var(--color-bg-panel)',
          borderRadius: 8,
          paddingBlock: 8,
        } as CSSProperties}
      >
        {children}
      </div>
    </section>
  );
}

/** 一个受控的草稿，好让每张卡都能真的打字（自动长高只有打字才看得出来）。 */
function useDraft(initial: string) {
  const [draft, setDraft] = useState(initial);
  return { draft, onDraftChange: setDraft };
}

/**
 * 实测读数。每一行对应上面注释里的一件事，**不用开 devtools**。
 *
 * 跟着 tick 重算：切主题、改草稿、切 hero 都会改这些数。
 */
function Readouts({ tick }: { tick: number }) {
  const [lines, setLines] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    const cls = (name: string) => `.${(name).split(' ')[0]!}`;
    const round = (n: number | undefined) => n === undefined ? '—' : String(Math.round(n));
    const rows: string[] = [];
    for (const host of document.querySelectorAll<HTMLElement>('[data-case]')) {
      const name = host.dataset['case'] ?? '?';
      const card = host.querySelector<HTMLElement>('[data-composer-card]');
      const scroll = host.querySelector<HTMLElement>('[data-input-scroll]');
      const area = host.querySelector('textarea');
      const send = [...host.querySelectorAll<HTMLElement>(cls(inputCss.primary))].at(-1);
      if (card === null || scroll === null || area === null) continue;
      const areaStyle = getComputedStyle(area);
      const sendStyle = send === undefined ? null : getComputedStyle(send);
      rows.push(
        `${name.padEnd(6, '　')}`
        + ` 卡 ${round(card.getBoundingClientRect().width)}×${round(card.getBoundingClientRect().height)}`
        + ` r=${getComputedStyle(card).borderTopLeftRadius}`
        + ` │ 滚动口 ${round(scroll.clientHeight)}px`
        + `（上限 336，实际内容 ${round(scroll.scrollHeight)}）`
        + ` 溢出=${getComputedStyle(scroll).overflowY}`
        + ` │ textarea resize=${areaStyle.resize} overflow-y=${areaStyle.overflowY}`
        + ` 高 ${round(area.getBoundingClientRect().height)}px`
        + ` 只读=${String(area.readOnly)}`
        + ` │ 发送钮 ${sendStyle === null ? '（未渲染）'
          : `${round(send?.getBoundingClientRect().width)}px r=${sendStyle.borderTopLeftRadius} bg=${sendStyle.backgroundColor} 失效=${String((send as HTMLButtonElement).disabled)}`}`,
      );
    }
    rows.push(
      'preflight 判据：textarea resize 必须是 none（否则右下角有把手）、overflow-y 必须是 hidden'
      + '（否则卡片里套两个滚动条）、发送钮 bg 不能是 rgba(0, 0, 0, 0)、r 必须是圆的。',
    );
    setLines(rows);
  }, [tick]);
  return (
    <div style={{
      flex: 'none',
      borderTop: '1px solid var(--color-border)',
      background: 'var(--color-bar)',
      color: 'var(--color-bar-text)',
      padding: '6px 10px',
      font: '11px/17px var(--font-mono)',
      whiteSpace: 'pre-wrap',
    }}>
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  );
}

function Fixture() {
  const { theme, toggleTheme } = useTheme();
  const [hero, setHero] = useState(false);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => { setTick(n => n + 1); }, []);
  const variant = hero ? 'hero' as const : 'composer' as const;

  const empty = useDraft('');
  const one = useDraft(ONE_LINE);
  const many = useDraft(MANY_LINES);
  const sending = useDraft('这一条正在提交，输入应当只读、发送钮应当失效');
  const off = useDraft('没有在跑的终端时整张卡不可用，但文字仍然选得中、复制得走');
  const over = useDraft('假装这段超过了 15 KiB 的后端上限');
  const seats = useDraft('把那些「喂不满就不画」的座位全部喂上假内容');

  // 读数要跟着草稿走：自动长高是在 layout effect 里量的，读数必须在它之后再读一遍。
  useLayoutEffect(bump, [empty.draft, one.draft, many.draft, sending.draft, off.draft, over.draft, seats.draft, hero, theme, bump]);

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--color-bg)', color: 'var(--color-text)',
    }}>
      <div style={{
        flex: 'none', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 10px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bar)', color: 'var(--color-bar-text)', fontSize: 12,
      }}>
        <button type="button" onClick={() => { toggleTheme(); bump(); }}>主题：{theme}</button>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={hero} onChange={e => { setHero(e.target.checked); }} />
          hero 变体（文本面下限 36 → 52px）
        </label>
        <span style={{ opacity: 0.7 }}>每张卡都能真的打字：⌘/Ctrl+Enter 发送（这里只 alert 一下）</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Case title="空草稿" note="占位行压在文本面上（不是原生 placeholder，那样会画两遍）；发送钮失效">
          <InputBar
            {...empty}
            variant={variant}
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case title="一行" note="卡片高度 = 一行 24 + 文本面的 36px 下限 + 工具条">
          <InputBar
            {...one}
            variant={variant}
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case title="20 行" note="超过 14 行的封顶：滚动口固定 336px，textarea 自己不滚">
          <InputBar
            {...many}
            variant={variant}
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case title="发送中" note="phase=submitting：只读 + 发送钮失效">
          <InputBar
            {...sending}
            variant={variant}
            phase="submitting"
            placeholder={PLACEHOLDER}
            sendLabel="提交中…"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case title="禁用" note="disabled：.inputDisabled 的灰 + aria-disabled；这是「没有在跑的终端」那一档">
          <InputBar
            {...off}
            variant={variant}
            disabled
            phase="inert"
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case title="超限" note="sendBlocked：输入不锁（还能删字），只关发送闸门；横幅走 .notice，不是 Toast">
          <InputBar
            {...over}
            variant={variant}
            sendBlocked
            notice={{ level: 'error', text: '内容超出 15 KiB 上限，请精简后再发' }}
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>

        <Case
          title="座位"
          note="线上不长这样：把喂不满的座位全喂上假内容，证明它们只是没传数据、不是画不出来"
        >
          <InputBar
            {...seats}
            variant={variant}
            placeholder={PLACEHOLDER}
            sendLabel="发送"
            stopLabel="停止"
            commandsLabel="命令"
            running
            stop={() => { window.alert('stop'); }}
            toggleCommandMenu={() => { window.alert('menu'); }}
            modes={
              <select className={inputCss.select} defaultValue="plan" aria-label="模式">
                <option value="plan">计划</option>
                <option value="ro">只读</option>
              </select>
            }
            modelSeat={
              <select className={inputCss.select} defaultValue="opus" aria-label="模型">
                <option value="opus">claude-opus</option>
                <option value="codex">codex</option>
              </select>
            }
            onSubmit={() => { window.alert('submit'); }}
          />
        </Case>
      </div>

      <Readouts tick={tick} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
