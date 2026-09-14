import type { Structure } from "./structure";

/**
 * **3D 查看器的契约。** 换实现时改的是实现，不是这个文件。
 *
 * 边界画在这儿的理由：预览组件真正关心的只有四件事——把它挂到某个容器上、给它一个结构、
 * 让它回到初始视角、卸载。剩下的（球棍半径、CPK 配色、轨迹球旋转的四元数、WebGL 上下文
 * 怎么复用）全是实现细节，不该有任何调用方认识它们。
 *
 * `show` 收的是 `Structure` 而不是一段文本：文本意味着要先选一种格式，而选格式就是在替
 * 下一个查看器做决定。能直接吃结构的查看器可以用上 `bondsKnown`，只吃 XYZ 文本的用
 * `toXyz()` 自己转一道——那是适配器的事，不是调用方的事。
 */
export type StructureViewer = {
  /** 挂到 host 上。同一个 host 可能被反复交给不同的结构。 */
  mount(host: HTMLElement, options: ViewerOptions): StructureView;
};

export type ViewerOptions = {
  /** 背景色，取自当前主题。查看器不该自己去读 CSS 变量。 */
  background: string;
};

export type StructureView = {
  /** 换一个结构。同一个视图可以被反复调用。 */
  show(structure: Structure): void;
  /** 回到初始视角（居中 + 适配大小）。 */
  resetView(): void;
  /** 容器尺寸变了。 */
  resize(): void;
  /** 背景色变了（主题切换）。 */
  setBackground(color: string): void;
  /** 不再需要这个视图。实现可以选择保留底层资源，调用方不必知道。 */
  dispose(): void;
};
