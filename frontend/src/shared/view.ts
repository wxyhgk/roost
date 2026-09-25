/**
 * 界面此刻在看什么。
 *
 * 这三个类型是**同一根轴上的三层**：看哪个工作区 → 看画布还是某一个终端 →
 * 那个终端看终端本身还是看对话。
 *
 * **它们刻意不长在组件文件里。** 原来 `Mode` 长在 `Shell.tsx`，而 `Shell` 渲染
 * `TerminalPane`，于是 `TerminalPane` 反过来 import 自己的父组件——一个引用环。
 * 类型是 type-only import，构建时会被擦掉，所以一直没出事；但环就是环，迟早会有
 * 一次不是 type-only 的引用顺着它长出来，那时才发现就晚了。
 * `Scope` 同理：它原来长在 `Sidebar.tsx`，让中间栏去依赖侧栏这个平级组件。
 *
 * 这条约束由 `frontend/tests/coupling-contracts.test.ts` 里的引用环检测守着。
 */

/**
 * 中间画布显示哪个工作区的终端。
 *
 * `"all"` 是全部，`null` 是未分组，其余是分组 ID。
 */
export type Scope = "all" | string | null;

/** 中间栏停在画布上，还是进了某一个终端。 */
export type Mode = "canvas" | "terminal";

/** 进了终端之后：看终端本身，还是看同一段对话的可读形态。 */
export type Lens = "tui" | "gui";

/**
 * 右侧面板此刻在看什么。和上面三个同一根轴，所以住在一起。
 *
 * 它**没有**写成 `"files" | "server" | NotesTab`——那样这个文件就要引用
 * `features/library` 的 `Kind`，而共享层不许依赖特性（check-boundaries 里那条
 * 「a shared layer must not depend on a feature」）。引用一下，它就不再是共享层了。
 *
 * 那两边会不会漂？不会，而且不靠自觉：`app/RightPanel.tsx` 里的 `titles` 同时被两个
 * 联合夹着——记录的键类型写的是 `"files" | "server" | NotesTab`，而取值用的是
 * `titles[view]`、`view: RightView`。`Kind` 多一个成员，记录字面量就少一个键；
 * `RightView` 多一个成员，取值就索引不到。两个方向都是 tsc 当场报错。
 */
export type RightView = "files" | "server" | "notes" | "snippets" | "processes" | "tasks";

/**
 * 选中的终端换了之后，范围该落在哪。
 *
 * 侧栏里「分组高亮」和「当前在哪个终端」原来是两条各走各的状态：高亮跟着 `Scope`，
 * 而选终端只动 `selectedId`。于是点开 B 组里的终端，A 组还亮着。
 *
 * 这不只是高亮说谎。`Scope` 还管两件实事——画布只显示范围内的终端（`scopedSessions`），
 * 新建终端放进当前范围（`TerminalPane` 里的 `addSession`）。两条状态一旦岔开，画布切过去
 * 看不到你正在用的那个终端，而「新建终端」会把新终端放进你已经离开的分组。
 *
 * **`"all"` 是唯一不跟随的。** 它不是「某个分组」，是「不筛」这个视角，是使用者主动选的；
 * 点一下终端就把画布收窄到一个分组，那是抢方向盘。而且「全部」亮着的时候你确实在看全部，
 * 高亮没说谎，本来就没有要修的东西。
 *
 * @param projectId 选中终端所在的分组；`null` 是未分组，`undefined` 是这个终端不在列表里
 *   （还没同步到、或者刚被关掉），此时不动——不知道该去哪就别动。
 */
export function scopeFollowingSession(scope: Scope, projectId: string | null | undefined): Scope {
  if (scope === "all" || projectId === undefined) return scope;
  return projectId;
}
