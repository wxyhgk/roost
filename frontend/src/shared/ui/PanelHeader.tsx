import type { ReactNode } from "react";

export function PanelHeader({
  icon,
  title,
  sub,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5 text-body font-semibold">
      {icon}
      {/* 字符串标题需要截断；节点标题（比如 tab 栏）要保持自己的布局，
          裹进 truncate 的 span 会把下边框裁掉、也撑不满高度。 */}
      {typeof title === "string" ? <span className="min-w-0 truncate">{title}</span> : title}
      {sub && (
        <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-xs font-normal text-text-dim">
          {sub}
        </span>
      )}
      {actions && (
        <div className={`flex shrink-0 items-center gap-0.5 ${sub ? "" : "ml-auto"}`}>{actions}</div>
      )}
    </header>
  );
}
