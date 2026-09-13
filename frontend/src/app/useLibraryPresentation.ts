import { useLayoutEffect, useRef, useState } from "react";

// Owns the native modal and the one portal host. Moving the host preserves the
// editor; detaching it when leaving the library prevents empty flex children.
export function useLibraryPresentation(visible: boolean) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const sideSlot = useRef<HTMLDivElement>(null);
  const modalSlot = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [contentHost] = useState(() => {
    const el = document.createElement("div"); el.className = "flex h-full min-h-0 flex-1 flex-col"; return el;
  });
  useLayoutEffect(() => {
    const modal = dialog.current;
    if (!visible) { contentHost.remove(); modal?.close(); setExpanded(false); return; }
    (expanded ? modalSlot.current : sideSlot.current)?.appendChild(contentHost);
    if (expanded && modal && !modal.open) { modal.showModal(); searchInput.current?.focus(); }
    else if (!expanded && modal?.open) { modal.close(); expandButton.current?.focus(); }
  }, [expanded, visible, contentHost]);
  useLayoutEffect(() => () => contentHost.remove(), [contentHost]);
  return { expanded, setExpanded, dialog, sideSlot, modalSlot, expandButton, searchInput, contentHost };
}
