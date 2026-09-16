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
      {/* 空屏上它是唯一的主信息，原来却是正文字号加 dim ——比旁边的说明文字只大 2px，
          又和背景一样灰。标题用标题字号，颜色回到正文色。 */}
      <div className="text-title text-text">{title}</div>
      {hint && <div className="text-caption text-text-dim/70">{hint}</div>}
      {action}
    </div>
  );
}
