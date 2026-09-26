import type { ReactNode } from "react";

export function PanelHeader({
  icon,
  title,
  sub,
  subTitle,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: string;
  /** `sub` 被缩短过时的全文，挂在 title 上。 */
  subTitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5 text-body font-semibold">
      {icon}
      {/* 字符串标题需要截断；节点标题（比如 tab 栏）要保持自己的布局，
          裹进 truncate 的 span 会把下边框裁掉、也撑不满高度。 */}
      {typeof title === "string" ? <span className="min-w-0 truncate">{title}</span> : title}
      {sub && (
        /* 元信息走 caption：和 13px 的标题同排，原来的 12 只比标题小 1px，读不出主次。
           `subTitle` 给缩短过的内容挂全文——短路径必须能问出完整路径，否则就是丢信息。 */
        <span title={subTitle} className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-caption font-normal text-text-dim">
          {sub}
        </span>
      )}
      {actions && (
        /*
          **控件和元信息之间要有一道线。** 原来右半边是「路径 显示 放大镜 下载」连成一串，
          读的人分不出哪些是「这是什么」、哪些是「我能做什么」。一条 border-l 加一点内边距
          就把两类东西分开了——比拉大间距省地方，也比拉大间距明确。
        */
        <div className={`flex shrink-0 items-center gap-0.5 ${sub ? "ml-2 border-l border-border pl-2" : "ml-auto"}`}>{actions}</div>
      )}
    </header>
  );
}
