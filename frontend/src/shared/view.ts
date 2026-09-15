/**
 * 界面此刻在看什么。
 *
 * 这几个类型是**同一根轴上的几层**：看哪个工作区 → 看画布还是某一个终端 →
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
 * 顶层模式：整套界面此刻是「对话」还是「终端」。
 *
 * **它换的是三栏，不只是左栏。** 原来这个位置叫 `LeftView`，只决定左栏列对话目录
 * 还是工作区树；但那两样各自还需要不同的中栏和右栏——对话要的是「目录 | 正文 | 终端」，
 * 终端要的是「工作区树 | 终端画面 | 文件树」。一个只切左栏的开关会让人点完之后还得
 * 再手动摆两栏，所以它升成了整套的切换：
 *
 * | | 左栏 | 中栏 | 右栏 |
 * | --- | --- | --- | --- |
 * | `"conversation"` | 对话目录 | 对话正文 | 终端画面 |
 * | `"terminal"` | 工作区树 | 终端画布 / TUI | 文件树等资料面板 |
 *
 * 两种模式的子状态（选中的对话、停在哪个终端、右栏各自看什么）**互不覆盖**，
 * 来回切要还在原处，所以 Shell 里凡是两边语义不同的状态都按模式分开存。
 */
export type Workbench = "conversation" | "terminal";

/**
 * 右侧**资料面板**此刻在看什么。和上面几个同一根轴，所以住在一起。
 *
 * 它**没有**写成 `"files" | "server" | NotesTab`——那样这个文件就要引用
 * `features/library` 的 `Kind`，而共享层不许依赖特性（check-boundaries 里那条
 * 「a shared layer must not depend on a feature」）。引用一下，它就不再是共享层了。
 *
 * 那两边会不会漂？不会，而且不靠自觉：`app/RightPanel.tsx` 里的 `titles` 同时被两个
 * 联合夹着——记录的键类型写的是 `"files" | "server" | NotesTab`，而取值用的是
 * `titles[view]`、`view: RightPanelView`。`Kind` 多一个成员，记录字面量就少一个键；
 * `RightPanelView` 多一个成员，取值就索引不到。两个方向都是 tsc 当场报错。
 */
export type RightPanelView = "files" | "server" | "notes" | "snippets";

/**
 * 右栏此刻装什么。**比 `RightPanelView` 多一档 `"terminal"`**：对话模式下终端住在右栏
 * （照搬上游——上游就是对话占中栏、终端在右侧的停靠面里），而那一档不是资料面板的一种，
 * 它根本不经过 `RightPanel`。所以两个类型分开：`RightPanel` 只收得下前四档，
 * 上面那条「两个联合互相夹着」的守护因此仍然成立。
 */
export type RightView = RightPanelView | "terminal";
