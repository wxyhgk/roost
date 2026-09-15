/*
  左栏外壳：列的几何、折叠动画，以及从上到下那五个座位
  （品牌行 → 折叠开关 → 新建会话 → 全局面板行 → 浏览区 → 底部设置）。

  抄自 deepseek-harness（MIT，`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`，
  提交 0d1f500）。**渲染结构（元素、顺序、className）和折叠的三段状态机一行未动**，
  改的全是「东西怎么进来」。ROOST-CHANGE 逐条：

  1. **插槽运行时换成 props / render prop。** 上游六处 `renderSlot('sidebar.*', …)` 走的是
     他们的 ui-slots 注册表，我们没有那套东西。品牌标记、面板图标换成 ReactNode；
     浏览区和底部两格换成 **render prop**，因为它们要收 `wide`——而 `wide` 不等于
     `collapsed`：折叠时它要再撑 150ms 等淡出结束（见下面那个 settled 状态），
     调用方自己算不出来。

  2. **`t(key)` 换成调用方给好的字符串**（`labels`）。上游这批组件的文案来自 slot 的
     locale seat，我们的 i18n 在 `@roost/i18n`，vendor 目录不认它。

  3. **`Tooltip` 换成原生 `title`。** 上游三处 `<Tooltip label=… delayMs={500}>` 包在按钮
     外面；`Tooltip` 不在这个目录里（NOTICE.md「没搬什么」的通用控件那一行）。折叠成
     56px 图标轨之后按钮只剩图标，**没有任何可读的名字**，所以不是「不接就算了」——
     `title` 是能喂满的最小替代，`aria-label` 上游本来就有，保持不动。

  4. **去掉 `localBuildVersion()`。** 上游从 `process.env.DSH_CLIENT_*` 三个构建期变量拼
     版本号，我们的 vite 没有定义它们，留着就是一个永远 undefined 的分支。改成
     `buildVersion` 这个可选 prop——CSS 里那三条（`.localBuildBrand` / `.localBuildTitle` /
     `.buildVersion`）照样能用，给不给由调用方决定。

  5. **面板行不再自己订阅。** 上游 `PanelRow` 用 `usePanelInfo(info => info.activePanelId === id)`
     只订自己那一格的选中态，那是他们 store 的优化；我们平铺成 `panels` 数组，`active`
     由调用方算好。

  **`.quietBars` 那套指针跟随留着了，但在我们这儿是空转的**：它重绑的是上游 ui-theme 的
  `--dsh-scrollbar-thumb` / `--dsh-scrollbar-hover`，而我们的滚动条在 `src/index.css` 里走
  `--color-scrollbar` 的全局规则，根本不读那两个变量。没有删是因为它是自包含的纯 React，
  哪天把滚动条改成读那两个变量，这一套当场就活了；删了将来要重写。
*/
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconNewChatOutline16, IconPanelLeftOutline16 } from '../icons/index.tsx'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/** 一条全局面板行。上游是 `SidebarPanelMetadata` + 一个 slot 渲染图标，这里平铺成一条记录。 */
export interface SidebarPanel {
  id: string
  /** 行上的文字，折叠态下用作 `title` / `aria-label`。 */
  label: string
  /** 图标。上游走 `renderSlot('sidebar.panellist', { size, active })`，size 由这里决定（展开 16、轨上 18）。 */
  icon: (props: { size: number; active: boolean }) => ReactNode
  active?: boolean | undefined
}

/** 浏览区（工作区/会话树）那一格收到的东西，对应上游 `sidebar.workspaces` 的 owner props。 */
export interface SidebarRegionOwner {
  /** 列现在是宽的吗。折叠动画期间它会比 `collapsed` 晚 150ms 翻。 */
  wide: boolean
  /** 请求把列展开（折叠态下点搜索之类要用）。 */
  expandSidebar: () => void
}

export interface SidebarRootLabels {
  /** 新建会话。品牌按钮和新建按钮共用它当 `aria-label`。 */
  newSession: string
  /** 新建按钮上的文字（展开态才画）。上游是另一个 key，不是 `aria-label` 那个。 */
  newSessionLabel: string
  /** 折叠开关的名字：折叠态显示「展开」，展开态显示「收起」。 */
  toggleOpen: string
  toggleCollapse: string
  /** 面板行那个 `<nav>` 的 `aria-label`。 */
  panels: string
}

export interface SidebarRootProps {
  /** 列是否折叠。折叠态是 **56px 图标轨**，不是宽度 0——轨的几何在 module.css 里。 */
  collapsed: boolean
  /** 展开态的列宽（px）。折叠动画期间内容被冻在这个宽度上淡出，由外面那层滑动的列裁掉。 */
  width: number
  labels: SidebarRootLabels
  /** 点品牌或点新建会话。上游这两处是同一个回调，这里照搬。 */
  onNewSession: () => void
  /** 点折叠开关。 */
  onToggle: () => void
  /** 品牌标记（24px 的图）。上游默认是他们的 FishLogo，那个没搬。 */
  brandMark?: ReactNode
  /** 品牌名。 */
  brandName?: ReactNode
  /** 版本号小徽章，给了才画。 */
  buildVersion?: string | undefined
  /** 全局面板行。空数组就整块不画（上游 `panels.length > 0`）。 */
  panels?: readonly SidebarPanel[] | undefined
  onSelectPanel?: ((id: string) => void) | undefined
  /** 浏览区：列的中间那一大块，宽窄两态都在。 */
  region?: ((owner: SidebarRegionOwner) => ReactNode) | undefined
  /** 底部附加动作，叠在设置之上。 */
  footerAction?: ((wide: boolean) => ReactNode) | undefined
  /** 底部设置。 */
  settings?: ((wide: boolean) => ReactNode) | undefined
}

/** 一条面板行。ROOST-CHANGE：选中态由 `active` 直接给，不再自己订阅 store。 */
function PanelRow({ panel, wide, onSelect }: {
  panel: SidebarPanel
  wide: boolean
  onSelect: (id: string) => void
}) {
  const active = panel.active === true
  return (
    <button
      type="button"
      className={clsx(css.panelRow, active && css.panelActive)}
      /* ROOST-CHANGE：上游这里包着 <Tooltip label={label} delayMs={500} disabled={wide}>。 */
      title={wide ? undefined : panel.label}
      aria-label={panel.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => { onSelect(panel.id) }}
    >
      <span className={css.panelGlyph} aria-hidden="true">
        {panel.icon({ size: wide ? 16 : 18, active })}
      </span>
      {wide && (
        <span className={clsx(css.panelTitle, css.wide)}>
          {panel.label}
        </span>
      )}
    </button>
  )
}

/**
 * 左栏外壳。
 *
 * 折叠是**滑动 + 交叉淡入淡出，不是变形**：内容先冻在展开时的宽度上原地淡出（150ms），
 * 淡完才换成图标轨的布局，所以滑动过程中不会有一次重排。冷启动直接是折叠态时没有
 * `.railIn`，图标静态画出来，不会先隐后现。
 *
 * **折叠态永远是 56px 的图标轨，不是宽度 0。** 列宽由外面那层（我们这边是 Shell 的栅格）
 * 控制，这个组件只负责把内容摆成轨的样子。
 * @param props - 见 SidebarRootProps。
 * @returns 左栏那一列。
 */
export function SidebarRoot({
  collapsed, width, labels, onNewSession, onToggle,
  brandMark, brandName, buildVersion, panels = [], onSelectPanel,
  region, footerAction, settings,
}: SidebarRootProps) {
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. A full-viewport panel rendered as a
  // fixed-position DESCENDANT of this column means a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.logoRow}>
        {/* Expanded, the brand doubles as a New Session shortcut; the
            collapsed rail's logo is the expand toggle below instead. */}
        {wide && (
          <button
            type="button"
            className={clsx(css.brand, css.wide)}
            aria-label={labels.newSession}
            onClick={() => { onNewSession() }}
          >
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>{brandMark}</span>
              <span className={css.brandName}>
                {buildVersion === undefined
                  ? <span className={css.fallbackBrandName}>{brandName}</span>
                  : (
                    <span className={css.localBuildBrand}>
                      <span className={css.localBuildTitle}>{brandName}</span>
                      <span className={css.buildVersion}>{buildVersion}</span>
                    </span>
                  )}
              </span>
            </span>
          </button>
        )}
        {/* Rail resting state is the brand mark; hovering swaps in the panel
            icon (the expand affordance). */}
        <button
          type="button"
          className={clsx(css.iconButton, css.toggle)}
          /* ROOST-CHANGE：上游这里包着 <Tooltip …>，见文件顶上第 3 条。 */
          title={collapsed ? labels.toggleOpen : labels.toggleCollapse}
          aria-label={collapsed ? labels.toggleOpen : labels.toggleCollapse}
          onClick={() => { onToggle() }}
        >
          {!wide && (
            <span className={css.railMark} aria-hidden="true">{brandMark}</span>
          )}
          {/* Rail icons render at 18; expanded keeps the glyph-native sizes. */}
          <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
        </button>
      </div>

      {/* Expanded, the button carries its own label — tooltip only on the rail. */}
      <button
        type="button"
        className={css.newSession}
        /* ROOST-CHANGE：上游这里包着 <Tooltip … disabled={wide}>，见文件顶上第 3 条。 */
        title={wide ? undefined : labels.newSession}
        aria-label={labels.newSession}
        onClick={() => { onNewSession() }}
      >
        <IconNewChatOutline16 size={wide ? 14 : 18} />
        {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{labels.newSessionLabel}</span>}
      </button>

      {panels.length > 0 && (
        <nav className={css.panelList} aria-label={labels.panels}>
          {panels.map(panel => (
            <PanelRow
              key={panel.id}
              panel={panel}
              wide={wide}
              onSelect={id => { onSelectPanel?.(id) }}
            />
          ))}
        </nav>
      )}

      {/* The browsing region fills the column between the controls and the
          foot in both states; its rail icon column rides the same slot. */}
      <div className={css.regionArea}>
        {region?.({
          wide,
          expandSidebar: () => { if (collapsed) onToggle() },
        })}
      </div>

      {/* Footer actions stack above Settings in both sidebar widths. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>{footerAction?.(wide)}</div>
        <div className={css.settingsArea}>{settings?.(wide)}</div>
      </div>
    </div>
  )
}
