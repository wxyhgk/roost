import { useEffect, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../clipboard";
import { t } from "@roost/i18n";

/**
 * 一小块可点击复制的只读值（ID、路径这类）。
 *
 * 显示的是截短版，复制的**始终是完整值**——截短只是为了放得下，不是内容本身。
 */
export function CopyChip({ value, label, display, icon, head = 6, tail = 4 }: {
  value: string;
  /** 读屏和 tooltip 用的说明，比如「对话 ID」。 */
  label: string;
  /** 自定义显示形式（比如路径只显示末两段）。不给就按首尾截短。 */
  display?: string;
  icon?: ReactNode;
  head?: number;
  tail?: number;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const short = display ?? (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value);

  return (
    <button
      type="button"
      title={`${label}：${value}`}
      aria-label={`${label} ${value}`}
      onPointerDown={e => e.stopPropagation()}
      onClick={async e => {
        e.stopPropagation();
        if (!(await writeClipboard(value))) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
      className="flex min-w-0 max-w-full items-center gap-1 rounded bg-text/6 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-text-dim transition-colors hover:bg-text/12 hover:text-text [&>svg]:h-2.5 [&>svg]:w-2.5"
    >
      {icon && <span className="grid shrink-0 place-items-center [&>svg]:h-2.5 [&>svg]:w-2.5" aria-hidden>{icon}</span>}
      <span className="min-w-0 truncate">{copied ? t.common.copied : short}</span>
    </button>
  );
}
