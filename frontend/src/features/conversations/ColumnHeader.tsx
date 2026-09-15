import { useCallback, useRef, useState, type ReactNode } from "react";
/*
  头的那几个位（面包屑 / 动作 / 工具 / 角落 / 标签条）和上游是同一套类。这份 CSS 在
  vendor 里逐字躺着；在接上之前一条规则都没生效——我们的头是自己拿 Tailwind 拼的。
*/
import shellCss from "../../vendor/dsh/skeleton/ConversationRoot.module.css";
/*
  **这一份必须自己引。** `tokens.css` 是 `--dsw-*` → 我们 `--color-*` 的桥接表，整批上游
  CSS Module 全靠它上色；它原来只随 `vendor/dsh/index.ts`（和 `layout/index.ts`）进来，
  而那条链的唯一入口是**懒加载的**对话模块。头搬到首屏之后，画布和 TUI 在对话 chunk
  下载之前拿到的是一整套空令牌——**不是颜色不对，是根本不上色**：`.header` 的下边框从
  一条暗线变成纯白，`.tab` 丢掉三档灰、选中态丢掉那点蓝，面包屑的 hover 底也没了。

  实测（fixture，深色）：canvas / tui 下 `--dsw-alias-label-tertiary`、
  `--dsw-alias-border-l3`、`--dsw-alias-state-business-primary` 三个读出来全是空串，
  `header` 的 border-bottom-color 是 rgb(245,245,247)；只有 gui 下才有值。
  **又是 NOTICE 第 3 条那一类**：typecheck 和单测全绿，只有画出来才看得见。
*/
import "../../vendor/dsh/tokens.css";
import { t } from "@roost/i18n";

/**
 * 中栏那**一个**头。
 *
 * ---- 为什么它从 ConversationDetail 里搬出来了 ----------------------------
 *
 * 上一轮只把**对话视角**收成了这个头，画布和 TUI 还留着 36px 的 `PanelHeader`，
 * 切视角时栏头跳 47px（实测 29.3 → 76）。当时的判断是「要消掉得把栏头整个提到
 * TerminalPane，而对话那半边的数据全在 ConversationDetail 的 state 里」。
 *
 * **那个判断的前提是错的。** 这个组件从来只吃插槽（几个 ReactNode 和一串面包屑），
 * 一点对话状态都不碰——真正住在 `ConversationDetail` state 里的只有喂给插槽的**内容**
 * （标题、run 决定的只读徽章、书签和角落菜单）。所以不需要把任何 state 提上去，
 * 只要让这个**组件**住在两边都 import 得到的地方，三个视角各自填自己的插槽。
 *
 * 放在 `features/conversations/` 而不是 `features/terminal/view/`，是因为 terminal
 * 有 `public.ts`：`scripts/check-boundaries.mjs` 那条「一个特性只要有 public.ts，
 * 别的特性就只能从那儿进」会让 conversations 反向 import 它直接变红。conversations
 * 没有 public.ts，所以方向反过来就通。
 *
 * **不能反过来把它留在 `ConversationDetail` 里导出**：那个模块是懒加载的
 * （见 TerminalLens 顶上的注释），TerminalPane 是首屏，静态 import 会把整棵
 * markdown 渲染树拖进首屏 chunk。
 *
 * ---- 形状 -------------------------------------------------------------
 *
 * 逐条对着上游的 `ConversationSessionHeader`
 * （`ui-conversation/src/client/skeleton/ConversationSession.tsx` 71-158 行）：
 *
 *     .titleRow
 *       .titleCluster [ nav.crumbs | .headerActions ]
 *       .headerUtilities            （:empty 时自己消失）
 *       .headerCorner               （单个控件，伸进右边距 16px）
 *     .tabs                         （**只在多于一格时出现**，和上游同一个判据）
 *
 * **不要在这里加行。** `.header` 的 `min-height: 76px` 等于右栏的标签条 38 + 窗格头 38，
 * 两条规则在栏边接得上；上游把 76 拆成 10 + 30 + 10 + 16 + 9，每一档都没有余量。
 * 需要更多地方的东西（告警、状态、展开的面板）要么去输入座位，要么绝对定位挂在头下面。
 */

/** 面包屑的一格。没有 `onClick` 的那格是「当前位置」，disabled 且加粗。 */
export type ColumnCrumb = { key: string; label: string; title?: string | undefined; onClick?: (() => void) | undefined };
/** 标签条的一格。上游只在**多于一个**视图时才画这条，所以只有一格等于不画。 */
export type ColumnTab = { id: string; label: string; title?: string | undefined; active: boolean };

/**
 * 头的几个位，由调用方填。
 *
 * 分成 prop 而不是一整块 ReactNode，是因为**位是有语义的**：`.headerActions` 是
 * 「此刻能对这条对话做什么」，`.headerUtilities` 是「属于这一栏而不是这条对话的控件」，
 * `.headerCorner` 是单个收尾控件。传一整块进来，位就退化成了一个 div。
 */
export type ColumnChrome = {
  /** 对话标题**之前**的几格。对话视角下最后一格由 ConversationDetail 自己补。 */
  crumbs?: readonly ColumnCrumb[] | undefined;
  /** 追加进 `.headerActions` 的动作，排在书签之前。 */
  actions?: ReactNode;
  /** `.headerUtilities`：工作目录、主题、搜索、下载这些属于栏的东西。 */
  utilities?: ReactNode;
  /**
   * 窄栏时要不要把工具位收进「更多」。默认收。
   *
   * 传 `false` 的场景只有一种：工具位里只有**一句短标签**（画布那个「N 个终端」），
   * 没有控件。收纳这一档是为了防止几块 `flex: none` 互相压，而一句 51px 的标签在
   * 399px 的栏里和面包屑并排还剩 250px 富余——给它配一颗「更多」，等于让人多点一下
   * 才能看到两个字。
   */
  utilitiesFoldable?: boolean | undefined;
  tabs?: readonly ColumnTab[] | undefined;
  tabsLabel?: string | undefined;
  onSelectTab?: ((id: string) => void) | undefined;
};

/**
 * `<header class=.header>` 这一层。
 *
 * 对话视角下它由 `ConversationShell` 画（那是 vendor 里逐字的一份，不能动），所以
 * 那条路只把 `ColumnHeader` 的内容当 `header` prop 传进去。画布和 TUI 没有壳，
 * 得自己包一层——**同一个类名、同一条 76px 契约**，三个视角才真的同高。
 *
 * 多一个 `relative`：那颗「更多」的浮层是 `absolute inset-x-2 top-[78px]`，对话那边
 * 靠 `.root`（CSS 第一条就是 `position: relative`）当包含块。这边没有壳，头自己来当。
 * 两种包含块解出来的矩形是同一个——`.root` 和 `.header` 一样宽、头贴着 `.root` 顶，
 * 所以 8px 内缩和「头底下 2px」两个数在两条路上都成立。
 */
export function ColumnHeaderFrame({ children }: { children: ReactNode }) {
  return <header className={`${shellCss.header} relative`}>{children}</header>;
}

/**
 * 头的内容。**只吃插槽**，不碰任何一边的业务状态——这正是三个视角能共用它的原因。
 */
export function ColumnHeader({
  crumbs, current, actions, utilities, utilitiesFoldable = true, corner, tabs, tabsLabel, onSelectTab,
}: {
  crumbs: readonly ColumnCrumb[];
  /** 链子的最后一格：你此刻在哪。disabled + `.crumbCurrent`，和上游同一个形状。 */
  current: ColumnCrumb;
  corner?: ReactNode;
} & Omit<ColumnChrome, "crumbs">) {
  const [row, width] = useRowWidth();
  /*
    **三档收纳。** 只有一行 30px 可用，而我们要放的东西比上游那个头多：面包屑、本终端
    历史、书签、只读徽章、跳到终端、工作目录、主题/搜索/下载、角落。全排开大约要 750px，
    而中栏的下限是 400（`vendor/dsh/layout/columns.ts` 的 CENTER_MIN，窗口再窄还会破）。

    **这条是截图才看出来的**：`.headerActions` 和 `.headerUtilities` 都是 `flex: none`，
    挤不下时不是换行也不是截断，而是直接压到彼此身上——400px 下三段文字叠在一起。
    typecheck 和单测对此一无所知（NOTICE 第 3 条记的就是这一类）。

    收的顺序按「离你正在看的东西有多远」：工具位（栏的东西）先收，动作位（这条对话的
    东西）后收，最后才动面包屑。收进「更多」的一样都不删；面包屑那档是**只留首尾**
    ——首格是唯一的返回路径，末格是「你在哪」，中间那些是可以推断的。
  */
  const foldUtilities = utilitiesFoldable && width !== null && width < 900;
  const foldActions = width !== null && width < 620;
  /*
    面包屑那一档的数是量出来的，不是估的。对话视角下把三格链子和右边那些东西全排开
    （实测，1920 窗口、深色 fixture）：面包屑自然宽 354、动作位 463、工具位 322、
    角落 16，加上 10+20+8 三道间距，一共要 1193。不够的时候被挤的**只有面包屑**
    （`.crumbs` 是这一行里唯一 min-width:0 的），而它挤掉的正是最右边那一格——
    也就是对话标题，全行最该看清的那个（截图里是「Ter… / conversatio… / T…」）。
    所以到 1200 就先把中间那些格收掉，只留首尾：首格是唯一的返回路径，末格是你在哪，
    中间那格（哪个终端）标签条和「本终端历史」都还说得出来。
  */
  const foldCrumbs = width !== null && width < 1200;
  const chain = foldCrumbs && crumbs.length > 1 ? [crumbs[0]!, current] : [...crumbs, current];
  // 渲染成片段而不是数组：数组会要 key，而这两块是固定的两块，不是列表。
  const overflowing = (foldActions && !!actions) || (foldUtilities && !!utilities);
  return (
    <>
      <div ref={row} className={shellCss.titleRow}>
        <div className={shellCss.titleCluster}>
          <nav className={shellCss.crumbs} aria-label={t.misc.conversations.detail.hierarchy}>
            {chain.map((crumb, index) => (
              <span key={crumb.key} className={shellCss.crumbSeg}>
                {index > 0 && <span className={shellCss.crumbSep}>/</span>}
                <button type="button" disabled={!crumb.onClick} title={crumb.title ?? crumb.label}
                  className={`${shellCss.crumb} ${crumb.onClick ? "" : shellCss.crumbCurrent}`}
                  onClick={crumb.onClick}>{crumb.label}</button>
              </span>
            ))}
          </nav>
          {(!foldActions && actions) || overflowing ? (
            <div className={shellCss.headerActions}>
              {!foldActions && actions}
              {/*
                「更多」面板**不加 `relative`**：让它挂到包含块上（对话那边是 `.root`，
                画布/TUI 那边是 `ColumnHeaderFrame` 自己），于是能横跨整栏摊开。挂在按钮
                自己身上试过——按钮在头的左半边，面板往哪边长都会有一半掉到栏外（截图里
                「本终端历史」和「只读历史」被切掉了半截）。`top-[78px]` 是头的 76 加一点缝。
              */}
              {overflowing && (
                <details className="shrink-0">
                  <summary className="flex cursor-pointer list-none items-center rounded-md border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover">
                    {t.misc.conversations.detail.more}
                  </summary>
                  {/* 收起来的东西横着摆一排、允许换行：它们本来就是一行控件，竖排会变成一张假菜单。 */}
                  <div className="absolute inset-x-2 top-[78px] z-30 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-panel p-2 shadow-lg">
                    {foldActions && actions}
                    {foldUtilities && utilities}
                  </div>
                </details>
              )}
            </div>
          ) : null}
        </div>
        <div className={shellCss.headerUtilities}>{!foldUtilities && utilities}</div>
        <div className={shellCss.headerCorner}>{corner}</div>
      </div>
      {/* 上游的判据逐字照搬：`tabs.length > 1`。只有一个视图时一条标签条什么也没在选。 */}
      {tabs && tabs.length > 1 && (
        <div className={shellCss.tabs} role="tablist" aria-label={tabsLabel}>
          {tabs.map(tab => (
            <button key={tab.id} type="button" role="tab" aria-selected={tab.active} title={tab.title}
              className={`${shellCss.tab} ${tab.active ? shellCss.tabActive : ""}`}
              onClick={() => onSelectTab?.(tab.id)}>{tab.label}</button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 量标题行的实际宽度。
 *
 * **不是视口宽度**：中栏的宽由左右两栏让出来，窗口 1600 而中栏 400 是常态
 * （`AppFrame` 的栏宽契约），按视口断点收纳会在那种布局下完全不起作用。
 *
 * 量到之前返回 `null`，按「不收」渲染——第一帧就摆出收起态，再在观察者回调里展开，
 * 会让每次挂载都闪一下。ResizeObserver 的首次回调在首帧绘制前就到。
 */
function useRowWidth(): [(node: HTMLDivElement | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    observer.current = new ResizeObserver(() => { setWidth(node.offsetWidth); });
    observer.current.observe(node);
    setWidth(node.offsetWidth);
  }, []);
  return [ref, width];
}
