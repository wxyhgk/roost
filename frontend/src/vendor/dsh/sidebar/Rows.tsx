/*
  左栏列表里的两种行：**会话行**（32px）和**分组头行**（34px，上游叫工作区行）。

  抄自 deepseek-harness（MIT，`packages/client/ui-workspace/src/client/rows/Rows.tsx`，
  提交 0d1f500，会话行是那份的 379-520 行）。**行的视觉结构一行未动**——元素、顺序、
  className、role、hover 时「时间换成 `…`」的那套交换全部照搬，CSS 也是逐字的
  （Rows.module.css）。改的全是「数据怎么进来」。ROOST-CHANGE 逐条：

  1. **props 从他们的树节点换成平的数据。** 上游每个行收的是 `SessionNode` / `GroupNode`
     ——那是 `tree.ts` 从他们的会话仓库派生出来的节点，连着 workspaceId、blank、
     pendingInteraction、runningSubagentCount、hasActiveSchedule 一串我们没有的字段。
     这里摊平成 `title` / `state` / `timeLabel` / `active` / `onOpen` 五个。

  2. **状态点的判定整段删掉，只留一个 `state` prop。** 上游 `sessionStatuses()` 那 40 行
     在「待审批 / 待回答 / 计划待看 / 自己在跑 / 子代理在跑 / 跑完没看 / 闲着」之间分优先级，
     每一条都读上游的实时会话状态。**我们一条都没有**——按 NOTICE.md 的规矩，喂不满的
     东西宁可不接。但 `state` 这个 prop 留着（连同 `stateLabel`），将来有了直接传。
     不传 `state` 时那个 16px 的状态槽**照样占位**（`.slot` 是固定宽的），所以以后补上
     状态点不会让整列标题横向跳一下。

  3. **`…` 菜单换成一个 ReactNode 座位。** 上游那里是 `<Menu items={[重命名/分叉/归档]}>`，
     `Menu` 没搬（NOTICE.md「没搬什么」的通用控件那一行），而且那三个动作我们一个都没有。
     座位留着，`menuOpen` 也留着——它是 CSS 要的：菜单开着时行要保持 hover 底色、
     `…` 要一直显形（`.menuOpen` 那三条规则）。配套导出 `RowIconButton`，这样调用方拼出来的
     按钮能吃到上游那个 16px 裸图标的样式。

  4. **HoverCard、拖拽插入、上游的 `blank`（还没发过消息的占位会话）、`hasActiveSchedule`
     全部没搬。** 前两个的依赖（`HoverCard` / 原生 drag 那套 store）不在这个目录里，
     后两个我们没有对应数据。CSS 里对应的规则（`.dropBefore` / `.hoverContent` / …）
     **留在 Rows.module.css 里没删**——那份要保持逐字，删了将来重新同步就成了三方合并。

  5. **搜索结果行 `SearchResultItem` 没搬。** 它读 `SearchResultNode` 的 workspace / snippet
     两个字段，我们的搜索接口（`shared/api/conversations`）不返回 snippet。
     CSS 同样留着。
*/
import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14 } from '../icons/index.tsx'
import { StateDot, type StateDotState } from '../StateDot.tsx'
import css from './Rows.module.css'

/**
 * 行尾那种 16px 的裸图标按钮（上游 `.iconButton`：无底色、tertiary 灰、hover 转 primary）。
 *
 * ROOST-CHANGE：上游没有这个组件，`…` 和 `+` 两个按钮是在行里就地写的。抽出来是因为
 * 菜单在我们这儿是调用方给的 ReactNode（见文件顶上第 3 条），而 `.iconButton` 这个类名
 * 隔着 CSS Module 调用方够不着。
 * @param props.label - 无障碍名字。
 * @param props.onClick - 点击。会 `stopPropagation`，否则会连带触发整行的 onOpen。
 * @param props.children - 图标。
 * @returns 一颗行尾按钮。
 */
export function RowIconButton({ label, onClick, children }: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={css.iconButton}
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      {children}
    </button>
  )
}

export interface SessionRowProps {
  /** 行上的标题。空标题由调用方兜底（上游是 blank 会话显示「新会话」）。 */
  title: string
  /**
   * 状态点。不给就不画点，但那 16px 的槽仍然占位——见文件顶上第 2 条。
   * `flat` 为真且没有状态时才会把槽也去掉（上游的扁平列表就是这么省那 16px 的）。
   */
  state?: StateDotState | undefined
  /** 状态点的屏幕阅读器文字。上游每个状态都有一句，画不出来但读得出来。 */
  stateLabel?: string | undefined
  /** 行尾的相对时间（`3min` / `2h` / `5d`）。hover 时它会让位给 `…`。不给就不画。 */
  timeLabel?: string | undefined
  /** 这一行是当前选中的那条。 */
  active?: boolean | undefined
  onOpen: () => void
  /** 行尾的 `…` 菜单座位。hover 或 `menuOpen` 时才显形。 */
  menu?: ReactNode
  /** 菜单正开着：行保持 hover 底色、`…` 保持显形。 */
  menuOpen?: boolean | undefined
  /** 没有父级分组头的扁平列表。没有状态点时连状态槽一起省掉。 */
  flat?: boolean | undefined
  /** 给了就在挂载后把这一行滚进可视区，然后回调一次（上游用在搜索跳转之后）。 */
  onReveal?: (() => void) | undefined
}

/**
 * 一条 32px 的会话行：状态点 → 标题 → 相对时间 → `…` 菜单。
 *
 * **hover 时相对时间换成 `…`**（CSS 干的，不是 JS），所以行宽不会因为多出一个按钮而变。
 * 几何是上游 figma 的会话格：左右各 8px 内边距、16px 状态槽、标题左 4px 右 6px。
 * @param props - 见 SessionRowProps。
 * @returns 一条会话行。
 */
export function SessionRow({
  title, state, stateLabel, timeLabel, active = false, onOpen,
  menu, menuOpen = false, flat = false, onReveal,
}: SessionRowProps) {
  const showStatus = state !== undefined
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (onReveal === undefined) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    onReveal()
  }, [onReveal])
  return (
    <div
      ref={rowRef}
      className={clsx(
        css.sessionRow, active && css.selected, menuOpen && css.menuOpen,
        flat && !showStatus && css.flatSessionRowWithoutStatus,
      )}
      role="treeitem"
      aria-selected={active}
      onClick={() => { onOpen() }}
    >
      {(!flat || showStatus) && (
        <span className={css.slot}>
          {showStatus && (
            <>
              <StateDot state={state} />
              {stateLabel !== undefined && <span className={css.visuallyHidden}>{stateLabel}</span>}
            </>
          )}
        </span>
      )}
      <span className={css.title}>{title}</span>
      {timeLabel !== undefined && <span className={css.time}>{timeLabel}</span>}
      {menu !== undefined && <span className={css.rowActions}>{menu}</span>}
    </div>
  )
}

export interface GroupRowProps {
  /** 分组名。上游是工作区名，我们可能是「今天」「昨天」。 */
  label: string
  expanded: boolean
  onToggle: () => void
  /**
   * 展开着、而且当前选中的那条就在这一组里——文件夹图标会点亮
   * （上游 `.folderActive`，用的是品牌蓝）。
   */
  containsActive?: boolean | undefined
  /** 行尾座位，hover 才显形。用 `RowIconButton` 拼。 */
  actions?: ReactNode
  /** 菜单正开着：行保持 hover 底色、行尾保持显形。 */
  menuOpen?: boolean | undefined
}

/**
 * 一条 34px 的分组头行：文件夹 → 展开箭头 → 标题 → 行尾动作。
 *
 * **文件夹和箭头是 hover 互换的**（CSS 干的）：静息显示文件夹，指上去换成能转的三角。
 * @param props - 见 GroupRowProps。
 * @returns 一条分组头行。
 */
export function GroupRow({
  label, expanded, onToggle, containsActive = false, actions, menuOpen = false,
}: GroupRowProps) {
  const active = expanded && containsActive
  return (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen)}
      role="treeitem"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{label}</span>
      </span>
      {actions !== undefined && <span className={css.rowActions}>{actions}</span>}
    </div>
  )
}
