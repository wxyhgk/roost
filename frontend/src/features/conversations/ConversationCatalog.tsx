import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ConversationList } from "./ConversationList";
import { IconButton } from "../../shared/ui/IconButton";
import { IconClose } from "../../shared/icons";
import { t } from "@roost/i18n";

/**
 * 历史对话目录，以浮层出现。
 *
 * 做成浮层而不是常驻栏位：找回某次对话是**偶发的搜索行为**，
 * 常驻一列意味着你多数时间在看用不上的记录——那正是这个面板原来显得乱的原因。
 */
export function ConversationCatalog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t.misc.conversations.catalogTitle}
        className="flex h-[80dvh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-modal outline-none">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="flex-1 text-body font-medium text-text">{t.misc.conversations.catalogTitle}</h2>
          <IconButton title={t.misc.conversations.close} onClick={onClose}><IconClose /></IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col"><ConversationList /></div>
      </div>
    </div>,
    document.body,
  );
}
