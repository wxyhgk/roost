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
