import { useCallback, useEffect, useState } from "react";
import { getTerminalHandle, subscribeSelection } from "../public";
import type { Cell } from "../types";
import { writeClipboard } from "../../../shared/clipboard";
import { useKeyboardInset } from "../../../shared/useKeyboardInset";
import { t } from "@roost/i18n";

/**
 * 触屏上的终端选区。
 *
 * 为什么要专门做：xterm 在 `.xterm` 上设了 `user-select: none`、自己管选区模型
 * （和用哪个渲染器无关），**浏览器里没有可选中的
 * DOM 文本**——手指长按不产生原生选区，`window.getSelection()` 也拿不到终端内容。
 * 所以选区只能建立在 xterm 的网格模型上，由「点起点、点终点」两次轻点构成。
 *
 * 刻意做成一个**显式的模式**而不是「长按即选」：默认状态下所有触点仍归浏览器，
 * 该滚动滚动、该点链接点链接。让每一次触摸都可能变成选区，会把最基本的浏览毁掉。
 */
export function useTouchSelection(sessionId: string) {
  const [on, setOn] = useState(false);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  const reset = useCallback(() => { setAnchor(null); setFocus(null); setCopied(null); }, []);
  const exit = useCallback(() => {
    setOn(false); reset();
    getTerminalHandle(sessionId)?.clearSelection();
  }, [sessionId, reset]);
  const enter = useCallback(() => { reset(); setOn(true); }, [reset]);

  // 换会话就退出：选区属于某一个终端，跨会话留着必然指向错误的文本。
  useEffect(() => { setOn(false); setAnchor(null); setFocus(null); setCopied(null); }, [sessionId]);

  // 选区被别的原因清掉（resize、回滚裁剪、切缓冲区）时，别再拿着一对失效的坐标。
  // 复用 subscribeSelection 是为了跟随句柄重建，而不是只在首次挂载时订阅一次。
  useEffect(() => {
    if (!on) return;
    return subscribeSelection(sessionId, () => {
      if (!getTerminalHandle(sessionId)?.getSelection()) { setAnchor(null); setFocus(null); }
    });
  }, [sessionId, on]);

  /** 一次轻点：第一下定起点，之后每一下都在移动终点。 */
  const tap = useCallback((clientX: number, clientY: number) => {
    const handle = getTerminalHandle(sessionId);
    const cell = handle?.pointToCell(clientX, clientY);
    if (!handle || !cell) return;
    setCopied(null);
    if (!anchor) {
      setAnchor(cell); setFocus(cell);
      handle.selectCells(cell, cell);
      return;
    }
    setFocus(cell);
    handle.selectCells(anchor, cell);
  }, [sessionId, anchor]);

  const copy = useCallback(async () => {
    // 取原文，不做尾部空白裁剪：复制走的是「原样拿走」的语义，
    // 裁剪属于存笔记时的展示处理，两者不能混。
    const text = getTerminalHandle(sessionId)?.getSelection() ?? "";
    if (!text) return;
    setCopied(await writeClipboard(text) ? "ok" : "fail");
  }, [sessionId]);

  /**
   * 立即取选区原文。必须在点击处理里同步调用：按钮拿到焦点会让选区状态变化，
   * 之后再读可能已经是空字符串。同样不做尾部裁剪。
   */
  const selectionText = useCallback(() => getTerminalHandle(sessionId)?.getSelection() ?? "", [sessionId]);

  return { on, anchor, focus, copied, enter, exit, reset, tap, copy, selectionText, hasRange: anchor !== null };
}

export function TouchSelectionBar({
  state, onSaveNote, onSaveSnippet, onSaveFile,
}: {
  state: ReturnType<typeof useTouchSelection>;
  onSaveNote: (text: string) => void;
  onSaveSnippet: (text: string) => void;
  onSaveFile: (text: string) => void;
}) {
  const keyboardInset = useKeyboardInset();
  // 按钮用 text-body、上面那行提示留 text-caption：原来是 12 压着 11，差 1px 读不出主次。
  const button = "shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 text-body text-bar-text/85 hover:bg-bar-text/10 disabled:opacity-40";
  const hint = state.copied === "ok" ? t.misc.selection.touch.copied
    : state.copied === "fail" ? t.misc.selection.touch.copyFailed
    : !state.anchor ? t.misc.selection.touch.hintAnchor
    : t.misc.selection.touch.hintRange;
  return (
    /*
      固定在底部，而不是跟着触点走：触屏没有光标，「在指尖旁边弹出」只会被手指本身挡住。

      **但 `bottom-0` 贴的是布局视口，不是看得见的那块。** iOS 上软键盘弹起来时布局视口
      一点都不缩（缩的是 visual viewport），于是这条栏就整条待在键盘底下——而「敲了几行、
      想把输出复制走」恰好是最常见的进入选区模式的路径，键盘那时多半还开着。

      让位用 `padding-bottom` 而不是改 `bottom`：元素底边仍然钉在布局视口底部，只是自己
      长高，内容被顶到键盘上方；多出来的那截背景藏在键盘后面，反正看不见。改 `bottom` 要
      求我们自己去算那块看得见的区域在哪，而 `useKeyboardInset` 给的正是「被挡住多少」。

      和安全区取 `max`：两者不会同时为正（iOS 在键盘弹起时把 safe-area-inset-bottom 报成
      0），取大的那个等于「谁在挡就听谁的」，不必判断是哪一种。
    */
    <div style={{ paddingBottom: `max(env(safe-area-inset-bottom), ${keyboardInset}px)` }}
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-30 flex flex-col gap-1 border-t border-bar-text/10 bg-bar px-2 pt-1.5 shadow-pop">
      <div role="status" className={`px-1 text-caption ${state.copied === "fail" ? "text-danger" : "text-bar-dim"}`}>{hint}</div>
      <div className="flex items-center gap-1 overflow-x-auto">
        <button type="button" className={button} disabled={!state.hasRange} onClick={() => void state.copy()}>
          {t.misc.selection.touch.copy}
        </button>
        <button type="button" className={button} disabled={!state.hasRange} onClick={() => onSaveNote(state.selectionText())}>{t.misc.selection.saveNote}</button>
        <button type="button" className={button} disabled={!state.hasRange} onClick={() => onSaveSnippet(state.selectionText())}>{t.misc.selection.saveSnippet}</button>
        <button type="button" className={button} disabled={!state.hasRange} onClick={() => onSaveFile(state.selectionText())}>{t.misc.selection.saveFile}</button>
        <span className="flex-1" />
        <button type="button" className={button} onClick={state.reset}>{t.misc.selection.touch.reset}</button>
        <button type="button" className={`${button} font-medium text-bar-text`} onClick={state.exit}>{t.misc.selection.touch.exit}</button>
      </div>
    </div>
  );
}
