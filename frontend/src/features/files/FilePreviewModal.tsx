import { useCallback, useEffect, useRef, useState } from "react";
import { writeFile, FileWriteError, type FilePreview, type FileWriteConflict } from "../../shared/api";
import { IconClose, IconPin } from "../../shared/icons";
import { detectLang } from "../../shared/code-highlight";
import { createEditor, matchPlugin, type EditorHandle } from "../../shared/editor";
import { EDITOR_PLUGINS } from "../../plugins";
import { NoticeBar } from "../../shared/ui/NoticeBar";
import { t } from "@roost/i18n";
import { FileIcon, HighlightedCode } from "./FileGlyphs";
import { useDraggablePanel } from "./useDraggablePanel";


/*
  拖动、缩放、边界收敛都在 useDraggablePanel 里。留在这儿的只有尺寸策略——
  最小多大、默认多大——因为那是这个弹窗自己的事：默认尺寸写在下面面板的
  className 里，hook 看不见。
*/
const MODAL_MIN_W = 480;
const MODAL_MIN_H = 320;
/** 必须和面板 className 里的 `w-[min(760px,92vw)]` / `min-h-[420px]` 对得上。 */
const MODAL_FALLBACK = { w: 760, h: 420 };

export function FilePreviewModal({
  preview,
  previewError,
  selected,
  cwd,
  onClose,
  onDirtyChange,
  initialLine,
  onInitialLineConsumed,
}: {
  preview: FilePreview | null;
  previewError: string | null;
  selected: string;
  cwd: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  initialLine?: number | null;
  onInitialLineConsumed?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [conflict, setConflict] = useState<FileWriteConflict | null>(null);
  const [savedMtime, setSavedMtime] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  // 钉住后点遮罩 / 按 Esc 不关闭, 只能点 X 或取消钉住。
  const [pinned, setPinned] = useState(false);
  const editorRef = useRef<EditorHandle | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const prevSelected = useRef(selected);
  const panel = useDraggablePanel({
    minWidth: MODAL_MIN_W,
    minHeight: MODAL_MIN_H,
    fallbackSize: MODAL_FALLBACK,
  });

  const canEdit = !!preview && !preview.binary && !preview.truncated;
  const plugin = preview ? matchPlugin(preview.name, EDITOR_PLUGINS) : null;
  // Binary originals (images, PDFs) render from the raw URL, not content.
  const customPreview =
    preview && plugin?.preview
      ? plugin.preview(preview.content, { name: preview.name, root: cwd, path: preview.path })
      : null;

  // Reset state when switching files.
  useEffect(() => {
    if (prevSelected.current !== selected) {
      prevSelected.current = selected;
      setEditing(false);
      setDirty(false);
      setConflict(null);
      setSaveError(null);
      setSavedMtime(null);
      setPinned(false);
      setEditorError(null);
    }
  }, [selected]);

  // Auto-enter edit mode for plain code files (no custom preview).
  useEffect(() => {
    if (preview && !preview.binary && !preview.truncated && !plugin?.preview) {
      setEditing(true);
    }
  }, [preview, plugin]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /*
    未保存的改动只在 CodeMirror 的缓冲里，关标签页或刷新就没了。这里有 dirty 标记、
    关闭确认和 mtime 冲突检测，唯独漏了这一条路——CLI 设置（CliSettings）和分子
    编辑器（plugins/molecule）都已经守住了，这里的标准要和它们一致。

    只 preventDefault，不设 returnValue：现代浏览器只认前者，而且提示语一律由浏览器
    自己决定，写什么都不会显示。
  */
  useEffect(() => {
    if (!editing || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, dirty]);

  const persist = useCallback(
    async (baseMtime: number) => {
      if (!preview || !editorRef.current || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      const content = editorRef.current.getContent();
      try {
        const res = await writeFile(cwd, selected, content, baseMtime);
        setSavedMtime(res.mtime);
        if (editorRef.current?.getContent() === content) setDirty(false);
        setConflict(null);
        setSaveError(null);
      } catch (err) {
        if (err instanceof FileWriteError && err.status === 409 && err.current) {
          setConflict(err.current);
          setSaveError(null);
        } else {
          setSaveError(err instanceof Error ? err.message : t.files.preview.saveFailed);
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [preview, selected, cwd],
  );

  // Mount / unmount the CodeMirror instance.
  useEffect(() => {
    if (!editing || !preview || preview.binary || preview.truncated || !hostRef.current) return;
    setEditorError(null);
    let handle: EditorHandle | null = null;
    try {
      handle = createEditor(
        hostRef.current,
        preview.content,
        preview.name,
        () => setDirty(true),
        EDITOR_PLUGINS,
      );
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : t.files.preview.editorFailed);
      return;
    }
    editorRef.current = handle;
    return () => {
      handle.dispose();
      if (editorRef.current === handle) editorRef.current = null;
    };
  }, [editing, preview]);

  // Navigate within the existing editor; a repeated link must not discard its draft.
  useEffect(() => {
    const handle = editorRef.current;
    if (!handle) return;
    if (initialLine != null) {
      try {
        const lineCount = handle.view.state.doc.lines;
        const line = Math.max(1, Math.min(initialLine, lineCount));
        const pos = handle.view.state.doc.line(line).from;
        handle.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      } finally {
        onInitialLineConsumed?.();
      }
    }
  }, [editing, preview, initialLine, onInitialLineConsumed]);

  // Take the keyboard on open so keys cannot fall through to the terminal. The editor
  // focuses itself once it mounts; this covers the gap before that and previews with no editor.
  useEffect(() => {
    panel.ref.current?.focus({ preventScroll: true });
  }, []);

  // Esc closes (unless pinned); Cmd/Ctrl+S saves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (pinned) return;
        if (editing && dirty && !window.confirm(t.files.preview.discardConfirm)) return;
        // Consume it: a stray Escape reaching the terminal interrupts whatever runs there.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editing) {
        e.preventDefault();
        void persist(savedMtime ?? preview?.mtime ?? 0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, dirty, onClose, savedMtime, preview, persist, pinned]);

  function enterEdit() {
    setEditing(true);
    setDirty(false);
    setConflict(null);
    setSaveError(null);
    setSavedMtime(null);
  }

  function exitEdit() {
    if (dirty && !window.confirm(t.files.preview.discardConfirm)) return;
    setEditing(false);
    setDirty(false);
    setConflict(null);
    setSaveError(null);
  }

  function reloadFromConflict() {
    if (!conflict) return;
    editorRef.current?.setContent(conflict.content);
    setSavedMtime(conflict.mtime);
    setDirty(false);
    setConflict(null);
  }

  const lineCount = preview ? preview.content.split("\n").length : 0;

  return (
    <div
      // 钉住后变成悬浮窗: 去掉遮罩, 事件点透, 终端可正常操作, 面板保持可拖动/缩放。
      // backdrop-filter 在弹窗移动时要每帧重算，是拖动卡顿的另一半原因。
      // 半透明黑本身已经足以把弹窗和背景分开，手势期间去掉模糊、松手再加回来。
      className={`fixed inset-0 z-[100] flex items-center justify-center ${
        pinned ? "pointer-events-none bg-transparent" : panel.gesturing ? "bg-black/50" : "bg-black/50 backdrop-blur-[4px]"
      }`}
      onClick={() => {
        if (panel.isGestureClick()) return;
        if (pinned) return;
        onClose();
      }}
    >
      <div
        ref={panel.ref}
        role="dialog"
        tabIndex={-1}
        aria-modal={!pinned}
        aria-label={preview?.name ?? selected}
        className="pointer-events-auto relative flex min-h-[420px] max-h-[80vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-modal"
        style={panel.style}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex h-9 shrink-0 cursor-move touch-none select-none items-center gap-2 border-b border-border px-3 font-mono text-xs"
          title={t.files.preview.moveHint}
          {...panel.moveHandlers}
        >
          <FileIcon name={preview?.name ?? selected} />
          <span className="flex-1 truncate">{preview?.name ?? selected}</span>
          {dirty && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t.files.preview.unsavedHint} />
          )}
          {canEdit && editing ? (
            <button
              className="rounded px-2 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text"
              onClick={exitEdit}
            >
              {t.files.preview.done}
            </button>
          ) : canEdit && !editing ? (
            <button
              className="rounded px-2 py-0.5 text-caption text-text-dim hover:bg-bg-hover hover:text-text"
              onClick={enterEdit}
            >
              {t.files.preview.edit}
            </button>
          ) : null}
          <button
            className={`grid h-5 w-5 shrink-0 place-items-center rounded-md hover:bg-bg-hover ${
              pinned ? "bg-bg-hover text-text" : "text-text-dim hover:text-text"
            }`}
            title={pinned ? t.files.preview.unpin : t.files.preview.pin}
            onClick={() => setPinned((v) => !v)}
          >
            <IconPin active={pinned} />
          </button>
          <button
            className="grid h-5 w-5 place-items-center rounded-md text-text-dim hover:bg-bg-hover hover:text-text"
            title={t.files.preview.close}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>

        {conflict && (
          <NoticeBar
            tone="warning"
            actions={
              <>
                <button className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-active hover:text-text" onClick={reloadFromConflict}>
                  {t.files.preview.loadLatest}
                </button>
                <button
                  className="shrink-0 rounded px-1.5 py-0.5 hover:bg-bg-active hover:text-text"
                  onClick={() => persist(conflict.mtime)}
                >
                  {t.files.preview.keepMine}
                </button>
              </>
            }
          >
            {t.files.preview.conflict}
          </NoticeBar>
        )}
        {preview?.truncated && (
          <NoticeBar tone="warning">
            {t.files.preview.tooLarge}
          </NoticeBar>
        )}

        <div className={`relative min-h-0 flex-1 ${editing ? "overflow-hidden" : "overflow-auto"}`}>
          {previewError && (
            <div className="px-2.5 py-2 text-body leading-[1.45] text-text-dim">{previewError}</div>
          )}
          {preview?.binary && !customPreview && (
            <div className="px-2.5 py-2 text-body leading-[1.45] text-text-dim">{t.files.preview.binary}</div>
          )}
          {editing && preview && !preview.binary && !preview.truncated ? (
            editorError ? (
              <div className="px-2.5 py-2 text-body leading-[1.45] text-danger">
                {t.files.preview.editorError(editorError)}
              </div>
            ) : (
              <div ref={hostRef} className="absolute inset-0" />
            )
          ) : customPreview ? (
            customPreview
          ) : preview && !preview.binary ? (
            <HighlightedCode
              code={preview.content + (preview.truncated ? t.files.preview.truncatedSuffix : "")}
              filename={preview.name}
            />
          ) : null}
        </div>

        {preview && (!preview.binary || customPreview) && (
          <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 pr-6 text-caption text-text-dim">
            {!editing && !preview.binary && (
              <>
                <span>{t.files.preview.lines(lineCount)}</span>
                <span>{t.files.preview.chars(preview.content.length.toLocaleString())}</span>
              </>
            )}
            {saveError && <span className="text-danger">{saveError}</span>}
            <span className="ml-auto">{plugin?.language ?? detectLang(preview.name)}</span>
            {preview.truncated && <span className="text-text-dim/70">{t.files.preview.truncated}</span>}
            {editing && (
              <button
                className="rounded px-1.5 py-0.5 text-text hover:bg-bg-hover disabled:opacity-50"
                onClick={() => persist(savedMtime ?? preview.mtime)}
                disabled={saving}
              >
                {t.files.preview.save}
              </button>
            )}
          </div>
        )}
        <div
          className="absolute bottom-1 right-1 z-10 h-4 w-4 cursor-nwse-resize touch-none text-text-dim/60 hover:text-text"
          title={t.files.preview.resizeHint}
          {...panel.resizeHandlers}
        >
          <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden>
            <path
              d="M4 12 L12 4 M8 12 L12 8 M12 12 L12 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
