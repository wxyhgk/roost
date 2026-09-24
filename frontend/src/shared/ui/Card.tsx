import type { ComponentProps, ReactNode } from "react";

/**
 * 卡片骨架：上下左右四条 bar 围着中间的内容区。
 *
 * ```
 * ┌──────── top ─────────┐   身份、状态、操作
 * │ l │            │ r   │
 * │ e │   children │ i   │   内容区（终端卡片放缩略图）
 * │ f │            │ g   │
 * │ t │            │ h   │
 * ├──────── bottom ──────┤   标题、元信息
 * └──────────────────────┘
 * ```
 *
 * **每条 bar 给了才存在，不给就不占位。** 这不只是省事：卡片只有 196px 宽，
 * 一条竖栏就要从内容区身上割掉 14%，而内容区放的是一张有比例的缩略图。所以
 * 左右两条是留给以后的接口，默认空着；上下两条是横向的，代价小得多。
 *
 * **该放进 bar 的东西不要浮在内容区上。** 浮层在今天这版（内容区是一个大图标）
 * 看着还行，等内容换成真的终端缩略图，它盖住的就是你想看的那几行字。
 */
export type CardProps = ComponentProps<"div"> & {
  top?: ReactNode;
  bottom?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  selected?: boolean;
  /**
   * `alert` 用于「这张卡在等你做点什么」。它同时染顶栏和整圈边框——一屏几十张
   * 卡的时候，只染角标是看不见的，边框才扫得到。
   */
  tone?: "normal" | "alert";
  dragging?: boolean;
};

export function Card({
  top, bottom, left, right, children, selected, tone = "normal", dragging, className, ...rest
}: CardProps) {
  const alert = tone === "alert";
  return (
    <div
      {...rest}
      /*
        默认态用 `raised`（微渐变 + 内描边高光）而不是一块纯色加一圈边框：纯色方块只靠
        「比背景浅」是读不出厚度的，而那道沿着上沿的亮边才是「这块浮起来了」的信号。

        选中和告警仍然走**实边框**——它们要盖过 rim 说一件更重要的事，而边框比内高光更
        容易一眼认出来。这两态因此保持纯色底，不叠渐变，免得边框和渐变互相打架。
      */
      className={`group relative flex select-none flex-col overflow-hidden rounded-2xl border transition-colors ${
        alert ? "border-warning bg-bg-panel"
        : selected ? "border-accent bg-bg-active/40"
        : "raised border-transparent hover:bg-bg-hover/50"
      } ${dragging ? "cursor-grabbing" : ""} ${className ?? ""}`}
    >
      {top && (
        <div className={`flex h-7 shrink-0 items-center gap-1.5 border-b px-1.5 text-caption ${
          alert
            // 顶栏染成警示色之后，里面的图标按钮默认那套灰色在黄底上看不清，
            // 一并换掉。.icon-button 是 IconButton 留给样式表的稳定钩子。
            ? "border-warning bg-warning font-semibold text-bg [&_.icon-button:hover]:bg-bg/10 [&_.icon-button:hover]:text-bg [&_.icon-button]:text-bg/70"
            : "border-border text-text-dim"
        }`}>
          {top}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {left && <div className="flex w-7 shrink-0 flex-col items-center gap-1 border-r border-border py-1.5">{left}</div>}
        <div className="relative min-w-0 flex-1">{children}</div>
        {right && <div className="flex w-7 shrink-0 flex-col items-center gap-1 border-l border-border py-1.5">{right}</div>}
      </div>
      {bottom && <div className="shrink-0 border-t border-border px-2.5 py-1.5">{bottom}</div>}
    </div>
  );
}
