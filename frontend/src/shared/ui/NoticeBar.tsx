import type { ReactNode } from "react";

const tones = {
  info: "border-border bg-bg-hover text-text-dim",
  warning: "border-warning/40 bg-warning-soft text-warning",
  error: "border-danger/40 bg-danger-soft text-danger",
  success: "border-success/40 bg-success-soft text-success",
} as const;

export type NoticeTone = keyof typeof tones;

export function NoticeBar({
  tone,
  actions,
  children,
}: {
  tone: NoticeTone;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-caption ${tones[tone]}`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {actions}
    </div>
  );
}
