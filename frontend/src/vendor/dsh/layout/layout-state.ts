/* 部分逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-layout/src/client/stores.ts —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md 和下面的 ROOST-CHANGE。 */
/*
  三栏外壳的布局状态：栏宽偏好、折叠态、右栏占位者报上来的呈现方式。

  搬自上游 `stores.ts` 的**布局那一半**。每个 action 的函数体几乎逐字，改的是承载它们的
  容器和一条策略：

  - ROOST-CHANGE 一：`defineStore` 换成 `useReducer`。上游那套 store 是他们引擎的一部分
    （immer draft + slot 注册表 + `ctx.layout` 绑定），整条链我们都没有。reducer 的每个
    分支就是上游那个 action 的函数体，`d.layoutInfo.x = y` 改成写在 `next` 上。

  - ROOST-CHANGE 二：**失配时退回原对象**（下面的 `unchanged`）。上游靠 immer 的结构共享
    白拿这件事——改了等于没改时 draft 返回同一个引用，订阅者不重渲染。useReducer 没有这层，
    而 `setViewportWidth` 由 ResizeObserver 每帧喂、`setSidebar` 由拖拽每帧喂，两个都极常见
    「算出来和上一帧一样」。不退回原对象的话，拖到夹逼边界之后每一帧仍然产生一个新对象，
    整棵树白渲染一遍。

  - ROOST-CHANGE 三：**去掉 `panelInfo`**（`activePanelId` / `selectPanel` /
    `retainMainPanels`）。那三个管的是「中栏此刻显示哪个全局面板」，是路由不是布局；
    上游把它和布局塞进同一个 store 是因为它们的 slot 运行时按 store 分发。我们的中栏
    内容由调用方直接作为 ReactNode 交给 AppFrame，这一层没有对应物。

  - ROOST-CHANGE 四：**加了持久化**。上游是**故意不持久化**的（它们 README 写着
    "Layout state resets on reload"）。这一条我们不跟：Roost 是本机单用户的工作台，
    左栏宽度是一次性调好就不该再动的东西，每次刷新回到 280px 是把「个人工作台」
    退化成「网页」。所以给 reducer 外面开一个口子（`LayoutPersistence`），默认不启用，
    由调用方决定存哪儿；`browserLayoutPersistence()` 是走 localStorage 的现成实现。

    **只存两个字段**（`sidebar` / `rightbar`），理由各不相同：
      · `viewportWidth` 是实测值，下次开窗口多大跟这次没关系；
      · `narrowExpanded` 是窄屏下的临时覆盖，上游自己在跨断点时就把它清掉，存下来等于
        把一次临时动作变成永久偏好；
      · `rightbarShown` / `rightbarTrack` / `rightbarFullscreen` / `rightbarInstant` 是
        右栏占位者报上来的**派生装饰**（见下面 LayoutInfo 的注释），真相在占位者那边，
        存在这里会在刷新后变成「框以为开着、占位者以为关着」。

  - ROOST-CHANGE 五：`resolveFrame` 从 AppFrame 的函数体里提了出来。那几行（narrow →
    sidebarCollapsed → 两次 computeColumns）在上游是组件内的局部变量，但它们是纯的，
    而且左栏占位者需要知道自己是不是折叠态——AppFrame 现在只收 ReactNode，没法像
    `renderSlot('sidebar', { collapsed, width })` 那样把参数注进去，所以调用方得能自己算
    同一份。提出来之后顺带可测。
*/
import { useEffect, useMemo, useReducer, useRef } from 'react'
import {
  clampWidth, computeColumns, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, type Columns,
} from './columns.ts'

/**
 * 布局偏好。响应式的让步**从不回写**这些字段——右栏被挤掉之后它的 px 偏好原样留着，
 * 窗口再拉宽就回来了。
 */
export type LayoutInfo = {
  /** 左栏宽度偏好，0 表示收起（宽屏下的收起就是把偏好置 0，所以重开等于回到契约默认值）。 */
  sidebar: number
  /** 最后一次为正的框实测宽度；首帧由 window.innerWidth 引导。 */
  viewportWidth: number
  /** 窄屏下手动展开左栏的覆盖位，跨断点时清掉。 */
  narrowExpanded: boolean
  /**
   * 右栏的 px 偏好，首次打开之前是 null。改窗口大小和关掉右栏都不动它。
   */
  rightbar: number | null
  /**
   * 右栏是不是画出来了（两种呈现都算）。
   *
   * **派生装饰，不是真相**：右面到底展开没展开是占位者自己记着的事实，报到这里只是
   * 为了让框知道该不该画那根拖拽把手。只有占位者写它。
   */
  rightbarShown: boolean
  /** 正常宽度是否占一条栅格轨道（全屏态下面也照占）。占位者报的，隐藏时恒为 false。 */
  rightbarTrack: boolean
  /** 占位者报上来的全屏呈现；全屏时把外面那根把手藏掉。 */
  rightbarFullscreen: boolean
  /** 退出全屏的那一帧压掉过渡，直到下一个几何动作。 */
  rightbarInstant: boolean
}

/** reducer 的动作表。一条对应上游 actions 里的一个函数。 */
export type LayoutAction =
  | { type: 'setSidebar'; px: number }
  | { type: 'toggleSidebar' }
  | { type: 'setViewportWidth'; width: number }
  | { type: 'setRightbar'; px: number }
  | { type: 'openRightbar'; track: boolean; fullscreen: boolean }
  | { type: 'closeRightbar' }

/** 绑好 dispatch 的动作集，形状和上游 store 的 actions 一一对应（少了第一个 draft 参数）。 */
export type LayoutActions = {
  setSidebar: (px: number) => void
  toggleSidebar: () => void
  setViewportWidth: (width: number) => void
  setRightbar: (px: number) => void
  openRightbar: (track: boolean, fullscreen: boolean) => void
  closeRightbar: () => void
}

/** 存得下来的那两个字段，见文件头 ROOST-CHANGE 四。 */
export type PersistedLayout = { sidebar: number; rightbar: number | null }

/** 持久化口子。给 `useLayoutState` 传一个就开启，不传就是上游的行为（刷新即复位）。 */
export type LayoutPersistence = {
  load: () => PersistedLayout | null
  save: (value: PersistedLayout) => void
}

/* 七个字段全是原始值，浅比就够。用显式的字段列表而不是 Object.keys 循环，是为了将来
   加字段时 tsc 会在这里报缺失，而不是悄悄漏掉一个比较。 */
function unchanged(a: LayoutInfo, b: LayoutInfo): boolean {
  return a.sidebar === b.sidebar
    && a.viewportWidth === b.viewportWidth
    && a.narrowExpanded === b.narrowExpanded
    && a.rightbar === b.rightbar
    && a.rightbarShown === b.rightbarShown
    && a.rightbarTrack === b.rightbarTrack
    && a.rightbarFullscreen === b.rightbarFullscreen
    && a.rightbarInstant === b.rightbarInstant
}

/**
 * 布局 reducer。
 *
 * 每个分支的算式都取自上游 `stores.ts` 的同名 action，一处没动：左栏的偏好**就是**宽度，
 * 所以收起会忘掉拖出来的宽度，重开回到契约默认值；右栏首次打开取框宽的 45%，那个 px
 * 偏好此后穿过改窗口和关闭一直留着；拖拽写入按当前框宽夹逼。窄屏切换左栏只动覆盖位，
 * 打开右栏会把覆盖位清掉。
 * @param state - 当前布局。
 * @param action - 要施加的动作。
 * @returns 新布局；算出来和原来一样时**返回原对象**（见文件头 ROOST-CHANGE 二）。
 */
export function layoutReducer(state: LayoutInfo, action: LayoutAction): LayoutInfo {
  const next = { ...state }
  switch (action.type) {
    case 'setSidebar':
      next.rightbarInstant = false
      next.sidebar = clampWidth(action.px, SIDEBAR_MIN, SIDEBAR_MAX)
      break
    // 窄屏切换只翻覆盖位：宽度偏好原封不动，所以窗口再拉宽会回到挤压之前的样子。
    case 'toggleSidebar':
      next.rightbarInstant = false
      if (next.viewportWidth < SIDEBAR_AUTO_COLLAPSE) next.narrowExpanded = !next.narrowExpanded
      else next.sidebar = next.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      break
    // 任一方向跨过断点都丢掉覆盖位：窄屏的默认是自动折叠，宽屏的状态是那个偏好。
    case 'setViewportWidth':
      if (next.viewportWidth === action.width) return state
      next.rightbarInstant = false
      if ((next.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !== (action.width < SIDEBAR_AUTO_COLLAPSE)) {
        next.narrowExpanded = false
      }
      next.viewportWidth = action.width
      break
    case 'setRightbar':
      next.rightbarInstant = false
      next.rightbar = clampWidth(action.px, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, next.viewportWidth * RIGHTBAR_MAX_RATIO))
      break
    case 'openRightbar':
      if (!next.rightbarShown || next.rightbarTrack !== action.track || next.rightbarFullscreen !== action.fullscreen) {
        next.rightbarInstant = next.rightbarFullscreen && !action.fullscreen
      }
      if (!next.rightbarShown && next.viewportWidth < SIDEBAR_AUTO_COLLAPSE) next.narrowExpanded = false
      next.rightbar ??= Math.max(RIGHTBAR_MIN, Math.round(next.viewportWidth * RIGHTBAR_DEFAULT_RATIO))
      next.rightbarShown = true
      next.rightbarTrack = action.track
      next.rightbarFullscreen = action.fullscreen
      break
    case 'closeRightbar':
      if (next.rightbarShown) next.rightbarInstant = next.rightbarFullscreen
      next.rightbarShown = false
      next.rightbarTrack = false
      next.rightbarFullscreen = false
      break
  }
  return unchanged(state, next) ? state : next
}

/**
 * 造初始布局。
 *
 * 存下来的值**必须过一遍夹逼**再用：localStorage 里躺着的是上一个版本的代码写进去的，
 * 也可能被人手改过。一个 NaN 或者 -1 进到 gridTemplateColumns 里，界面就是一条永远修不好的
 * 坏栏——而那时候没人会想到去翻存储。
 * @param persisted - 读出来的偏好，没有就传 null。
 * @param viewportWidth - 首帧的框宽，默认取窗口宽度。
 * @returns 可以直接喂给 reducer 的初始态。
 */
export function initLayout(persisted: PersistedLayout | null, viewportWidth: number): LayoutInfo {
  const sidebar = persisted !== null && Number.isFinite(persisted.sidebar)
    ? (persisted.sidebar === 0 ? 0 : clampWidth(persisted.sidebar, SIDEBAR_MIN, SIDEBAR_MAX))
    : SIDEBAR_DEFAULT
  const stored = persisted?.rightbar
  const rightbar = typeof stored === 'number' && Number.isFinite(stored)
    ? clampWidth(stored, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, viewportWidth * RIGHTBAR_MAX_RATIO))
    : null
  return {
    sidebar,
    viewportWidth,
    narrowExpanded: false,
    rightbar,
    rightbarShown: false,
    rightbarTrack: false,
    rightbarFullscreen: false,
    rightbarInstant: false,
  }
}

/**
 * localStorage 版的持久化口子。
 *
 * 读写都包 try：无痕窗口和「禁止站点数据」下 localStorage 的存取器**会抛**，而布局
 * 是外壳的第一帧——在那里抛等于整个界面白屏。存不下来最多是刷新后回到默认宽度。
 * @param key - 存储键。
 * @returns 可以交给 `useLayoutState` 的实现。
 */
export function browserLayoutPersistence(key: string): LayoutPersistence {
  return {
    load: () => {
      try {
        const raw = localStorage.getItem(key)
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return null
        const { sidebar, rightbar } = parsed as Partial<PersistedLayout>
        return {
          sidebar: typeof sidebar === 'number' ? sidebar : SIDEBAR_DEFAULT,
          rightbar: typeof rightbar === 'number' ? rightbar : null,
        }
      } catch { return null }
    },
    save: (value) => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 存不下就算了 */ }
    },
  }
}

/** 一帧里解出来的几何：谁折叠、两次求解各得到什么。 */
export type FrameGeometry = {
  /** 框宽是否在自动折叠断点以下。 */
  narrow: boolean
  /** 左栏此刻是不是那条 56px 的图标轨。 */
  sidebarCollapsed: boolean
  /** 交给 computeColumns 的左栏偏好（0 = 收起）。 */
  sidebarPreference: number
  /** 交给 computeColumns 的右栏偏好。 */
  rightbarPreference: number
  /** 「右栏按正常宽度展开」时的解——右面板按它画，跟占位者报没报轨道无关。 */
  normal: Columns
  /** 实际落到栅格上的解。 */
  cols: Columns
}

/**
 * 把布局状态解成三栏几何。函数体逐字取自上游 AppFrame 里的那六行局部变量。
 * @param info - 当前布局状态。
 * @returns 这一帧的几何。
 */
export function resolveFrame(info: LayoutInfo): FrameGeometry {
  const viewport = info.viewportWidth
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !info.narrowExpanded : info.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : info.sidebar === 0 ? SIDEBAR_DEFAULT : info.sidebar
  const rightbarPreference = info.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // 窄框上打开右栏会把左栏折掉。够不够地方要在占位者报出第一个 shown 之前就把那块地算进去。
  const normal = computeColumns(viewport, !info.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference)
  const cols = computeColumns(viewport, sidebarPreference, info.rightbarTrack ? rightbarPreference : 0)
  return { narrow, sidebarCollapsed, sidebarPreference, rightbarPreference, normal, cols }
}

/**
 * 持有一份布局状态。AppFrame 是受控的，这个 hook 是它的默认拥有者。
 *
 * `actions` 只依赖 dispatch（永远稳定），所以它自己也是稳定的——AppFrame 的
 * ResizeObserver effect 把它写在依赖里，不稳定就等于每次渲染都重装一次观察器。
 * @param persistence - 持久化口子，不传则刷新后复位（上游行为）。**不要求它稳定**：
 *   保存走 ref，只有那两个字段变了才写。
 * @returns 当前布局、绑好的动作集、以及这一帧解出来的几何。
 */
export function useLayoutState(persistence?: LayoutPersistence): {
  layout: LayoutInfo
  actions: LayoutActions
  geometry: FrameGeometry
} {
  const [layout, dispatch] = useReducer(
    layoutReducer,
    persistence ?? null,
    (p) => initLayout(p?.load() ?? null, window.innerWidth),
  )
  const actions = useMemo<LayoutActions>(() => ({
    setSidebar: (px) => { dispatch({ type: 'setSidebar', px }) },
    toggleSidebar: () => { dispatch({ type: 'toggleSidebar' }) },
    setViewportWidth: (width) => { dispatch({ type: 'setViewportWidth', width }) },
    setRightbar: (px) => { dispatch({ type: 'setRightbar', px }) },
    openRightbar: (track, fullscreen) => { dispatch({ type: 'openRightbar', track, fullscreen }) },
    closeRightbar: () => { dispatch({ type: 'closeRightbar' }) },
  }), [])

  const sink = useRef(persistence)
  sink.current = persistence
  const { sidebar, rightbar } = layout
  useEffect(() => { sink.current?.save({ sidebar, rightbar }) }, [sidebar, rightbar])

  const geometry = resolveFrame(layout)
  return { layout, actions, geometry }
}
