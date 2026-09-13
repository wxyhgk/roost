import type { ReactNode } from "react";

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
      <div className="text-body text-text-dim">{title}</div>
      {hint && <div className="text-caption text-text-dim/70">{hint}</div>}
      {action}
    </div>
  );
}
