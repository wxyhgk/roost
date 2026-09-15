/*
  浏览区的**壳**：区段头（标题 + 内联展开的搜索框 + 尾部动作）、滚动列表、底部渐隐，
  以及「一组最多先露 5 条，其余折起来」的分组盒子。

  抄自 deepseek-harness（MIT，`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx`，
  提交 0d1f500）。**这个文件不是逐字抄的。** 上游那份 1334 行，绝大多数是我们没有的东西：
  工作区/会话的派生树（`tree.ts`）、内容搜索的 RPC 与防抖、拖拽重排、重命名/删除对话框、
  目录选择流程、他们的 store 订阅。搬整份等于把半个上游应用搬进来，所以这里只留
  **DOM 结构和 WorkspaceBrowser.module.css 认得的那些 className**，其余全部换成 props。

  搬过来的结构（和上游 1042-1190 行一一对应）：

      .root[.rail]
        .sectionHeader
          .sectionLabel[.sectionLabelHidden]   ← 搜索展开时它让位
          .searchSlot[.searchSlotExpanded]
            .search[.searchExpanded]           ← 一颗圆按钮长成一条输入框
          .headerActions[.headerActionsHidden] ← 搜索展开时它收起来
        .search                                ← 折叠态：轨上单独一颗 36px 搜索钮
        .listArea
          .treeBody
            .list                              ← 唯一滚动的那层
            .fade                              ← 底部渐隐

  ROOST-CHANGE 逐条：

  1. **分组由调用方给。** 上游按工作区分组（`deriveGroups`），组是从他们的会话仓库派生的。
     这里 `SidebarGroup` 只管「头 + 前 N 条 + 折叠按钮」这个壳，按什么分组、组里是什么行，
     调用方说了算（我们大概会按天）。

  2. **每组的折叠状态收在组自己身上。** 上游存在浏览器根的 `expandedSessionGroups` 数组里，
     那是因为它还要和拖拽、搜索跳转联动。我们没有那两件事。

  3. **搜索只剩一个受控输入。** 上游那 250ms 防抖 + 内容搜索 RPC + 结果列表全在调用方那边
     （我们已经有一份，`features/conversations/ConversationRows.tsx`），这里只负责那个
     「圆钮长成输入框」的展开动画和它的 DOM。

  4. **`sanitizeSearchQuery` 的上限改成参数。** 上游写死他们 `session.search` 的 500 码元
     线协议上限；我们的上限在 `shared/api/conversations` 里，vendor 目录不该认识它。
     函数体（包括那段避免把代理对劈成两半的处理）一字未动。

  5. **`Tooltip` 换成原生 `title`，`Menu` / `Modal` / `Button` 相关的一切没搬**——理由同
     SidebarRoot.tsx 第 3 条，那几个控件不在这个目录里。上游区段头右边那两颗
     （视图选项菜单、加工作区）换成 `headerActions` 这个 ReactNode 座位。
*/
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, IconSearchOutline16 } from '../icons/index.tsx'
import css from './WorkspaceBrowser.module.css'

/** Session rows visible per Workspace before the local overflow control. */
export const COLLAPSED_SESSION_LIMIT = 5

/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 500

/**
 * Keep controlled input and RPC payload inside the search wire contract.
 *
 * ROOST-CHANGE：上限从上游写死的常量改成参数（默认仍是那个常量），见文件顶上第 4 条。
 * @param value - 输入框里的原文。
 * @param max - 上限，按 UTF-16 码元算。
 * @returns 截断到上限、且不会把代理对劈成两半的字符串。
 */
export function sanitizeSearchQuery(value: string, max = SEARCH_QUERY_MAX_CODE_UNITS): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= max) return withoutNul
  let end = max
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

export interface SidebarBrowserLabels {
  /** 区段头上的标题。 */
  section: string
  /** 搜索按钮的名字（折叠态下它是轨上唯一的提示）。 */
  search: string
  searchPlaceholder: string
  searchClear: string
}

export interface SidebarBrowserProps {
  /** 列现在是宽的吗。由 `SidebarRoot` 的 region render prop 递进来。 */
  wide: boolean
  labels: SidebarBrowserLabels
  /** 搜索词。受控——防抖和真正的搜索都在调用方。 */
  query: string
  onQueryChange: (query: string) => void
  /** 搜索词上限，按 UTF-16 码元算。 */
  maxQueryLength?: number | undefined
  /** 区段头右边那一撮按钮。上游是视图选项菜单 + 加工作区。 */
  headerActions?: ReactNode
  /** 折叠态下点搜索钮：请求把列展开。 */
  onExpandSidebar?: (() => void) | undefined
  /**
   * 列表里**没有分组**（上游的「一个列表里全放下」视图）。开着时相邻两行之间 2px，
   * 而不是分组之间的 4px。
   */
  flat?: boolean | undefined
  /** 列表本体。`wide` 为假时不画（轨上只有两颗图标）。 */
  children?: ReactNode
}

/**
 * 浏览区的壳。
 *
 * **搜索框是「内联展开」的**：静息时它就是区段头右边一颗 28px 的圆钮，点下去之后
 * 标题和尾部动作各自往两边收，它自己长成一条 30px 的输入框。整个过程是 CSS 过渡，
 * 没有任何元素挂载/卸载——所以输入焦点不会在中途丢掉。
 * @param props - 见 SidebarBrowserProps。
 * @returns 浏览区。
 */
export function SidebarBrowser({
  wide, labels, query, onQueryChange, maxQueryLength, headerActions, onExpandSidebar,
  flat = false, children,
}: SidebarBrowserProps) {
  const [searchExpanded, setSearchExpanded] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  return (
    <div className={clsx(css.root, !wide && css.rail)}>
      <div className={css.sectionHeader}>
        {wide && (
          <span className={clsx(css.sectionLabel, css.wide, searchExpanded && css.sectionLabelHidden)}>
            {labels.section}
          </span>
        )}
        {wide && (
          <div className={clsx(css.searchSlot, searchExpanded && css.searchSlotExpanded)}>
            <div
              className={clsx(css.search, searchExpanded && css.searchExpanded)}
              onClick={() => {
                setSearchExpanded(true)
                searchInput.current?.focus()
              }}
            >
              <button
                type="button"
                className={css.searchButton}
                /* ROOST-CHANGE：上游这里包着 <Tooltip … disabled={searchExpanded}>。 */
                title={searchExpanded ? undefined : labels.search}
                aria-label={labels.search}
                aria-expanded={searchExpanded}
                onClick={() => { setSearchExpanded(true) }}
              >
                <IconSearchOutline16 size={searchExpanded ? 11 : 14} />
              </button>
              <input
                ref={searchInput}
                className={css.searchInput}
                type="text"
                placeholder={labels.searchPlaceholder}
                maxLength={maxQueryLength ?? SEARCH_QUERY_MAX_CODE_UNITS}
                value={query}
                tabIndex={searchExpanded ? 0 : -1}
                onChange={(e) => { onQueryChange(sanitizeSearchQuery(e.target.value, maxQueryLength)) }}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  onQueryChange('')
                  setSearchExpanded(false)
                }}
              />
              {searchExpanded && (
                <button
                  type="button"
                  className={css.clearButton}
                  aria-label={labels.searchClear}
                  onClick={(e) => {
                    e.stopPropagation()
                    onQueryChange('')
                    setSearchExpanded(false)
                  }}
                >
                  <IconCloseFill14 />
                </button>
              )}
            </div>
          </div>
        )}
        {headerActions !== undefined && (
          <div className={clsx(css.headerActions, wide && searchExpanded && css.headerActionsHidden)}>
            {headerActions}
          </div>
        )}
      </div>

      {/* The collapsed rail keeps search as its own 36px control. */}
      {!wide && (
        <div className={css.search}>
          <button
            type="button"
            className={css.searchButton}
            title={labels.search}
            aria-label={labels.search}
            onClick={() => {
              setSearchExpanded(true)
              onExpandSidebar?.()
            }}
          >
            <IconSearchOutline16 size={18} />
          </button>
        </div>
      )}

      {/* Always-mounted seat keeps the region's flex slot while the list
          itself is wide-only. */}
      <div className={css.listArea}>
        {wide && (
          <div className={clsx(css.treeBody, css.wide)}>
            <div className={clsx(css.list, flat && css.flatList)} role="tree" aria-label={labels.section}>
              {children}
            </div>
            <span className={css.fade} />
          </div>
        )}
      </div>
    </div>
  )
}

/** 列表里的空态一行（上游 `.empty`）。 */
export function SidebarBrowserEmpty({ children }: { children: ReactNode }) {
  return <div className={css.empty}>{children}</div>
}

export interface SidebarGroupLabels {
  /** 「还有 n 条」。 */
  expand: (hidden: number) => string
  /** 「收起」。 */
  collapse: string
}

export interface SidebarGroupProps<T> {
  /** 分组头。通常是一个 `<GroupRow>`。不给就只有一串行（扁平列表）。 */
  header?: ReactNode
  labels: SidebarGroupLabels
  /** 组里的条目。超出 `limit` 的那些由折叠按钮控制。 */
  items: readonly T[]
  /** 怎么把一个条目画成一行。**返回的元素要自带 key**。 */
  renderItem: (item: T, index: number) => ReactNode
  /** 先露几条。默认 5，和上游一样。 */
  limit?: number | undefined
}

/**
 * 一个分组：头 + 最多 `limit` 条 + 「还有 n 条」。
 *
 * **折叠状态收在组自己身上**（ROOST-CHANGE 第 2 条）。超出的条目是**不挂载**的，不是
 * 用 CSS 藏起来的——一组里几百条对话时这一条决定了滚动列表的 DOM 规模。
 *
 * 收的是 `items` + `renderItem` 而不是 children：**children 数不准**。调用方只要把那串行
 * 包进一个自己的组件（`<Rows/>`），`Children.toArray` 看到的就是 1 个孩子，上限当场失效
 * 而且一声不吭——写 fixture 的时候正好踩到了。上游那里是 `group.sessions.map(…)`，
 * 数的也是数据不是元素。
 * @param props - 见 SidebarGroupProps。
 * @returns 一个 `.groupSection`。
 */
export function SidebarGroup<T>({
  header, labels, items, renderItem, limit = COLLAPSED_SESSION_LIMIT,
}: SidebarGroupProps<T>) {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(0, items.length - limit)
  const shown = expanded ? items : items.slice(0, limit)
  return (
    <div className={css.groupSection}>
      {header}
      {shown.map((item, index) => renderItem(item, index))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className={css.sessionOverflowButton}
          aria-expanded={expanded}
          onClick={() => { setExpanded(v => !v) }}
        >
          {expanded ? labels.collapse : labels.expand(hiddenCount)}
        </button>
      )}
    </div>
  )
}
