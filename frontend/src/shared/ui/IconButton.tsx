import type { ReactNode, Ref } from "react";

type ClickEvent = {
  stopPropagation(): void;
  preventDefault(): void;
};

export function IconButton({
  title,
  onClick,
  onPointerDown,
  danger,
  inverse,
  className,
  ref,
  children,
}: {
  title: string;
  onClick?: (e: ClickEvent) => void;
  onPointerDown?: (e: ClickEvent) => void;
  danger?: boolean;
  inverse?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  const palette = inverse
    ? "text-bar-dim hover:bg-bar-text/10 hover:text-bar-text"
    : "text-text-dim hover:bg-bg-hover hover:text-text";
  return (
    <button
      type="button"
      ref={ref}
      // icon-button 是给样式表用的稳定钩子：粗指针设备上要把点击区域放大到能用的尺寸，
      // 那条规则写在 index.css 的媒体查询里，桌面完全不受影响。
      className={`icon-button grid h-5 w-5 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${palette} ${
        danger && !inverse ? "hover:text-danger" : ""
      } ${className ?? ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {children}
    </button>
  );
}
