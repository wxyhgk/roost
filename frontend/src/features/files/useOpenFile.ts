import { useCallback, useRef, useState } from "react";
import { getTerminalHandle } from "../terminal/public";
import { t } from "@roost/i18n";

/**
 * 「现在打开的是哪个文件」——只管这一件事。
 *
 * 打开的请求有四个来源：在树上点、终端输出里的文件链接、命令面板跳转、新建之后自动
 * 选中。**四条路必须汇到这里的同一个 `open`**，因为每一次打开都要做同样三件事：
 * 问一句未保存的修改、记住根目录快照、记住是不是从终端点过来的。分散在四处写，
 * 漏掉任何一处都是一个只在特定入口出现的 bug。
 *
 * 「谁在要求打开」不在这里，在 `useExternalOpen`：那是输入，这是状态。
 */
export function useOpenFile({ cwd, sessionId, initialFile, hasUnsavedChanges, onOpened }: {
  cwd: string;
  sessionId: string;
  initialFile: string | null;
  /**
   * 当前打开的东西有没有未保存的修改。**每次都重新读**而不是传一个值进来：
   * 这个答案只在一次打开请求发生的那一刻才有意义，提前捕获会拿到过期的。
   */
  hasUnsavedChanges(): boolean;
  /** 真的换了文件。用来清掉上一份的脏标记之类。 */
  onOpened(path: string): void;
}) {
  const [selected, setSelected] = useState<string | null>(initialFile);
  /**
   * 打开那一刻的根目录快照。
   *
   * 终端之后 `cd` 走了不该换掉正在看的文件——读内容、保存、冲突检测都得对着当初
   * 那个根，否则同一个相对路径会指到别的文件上去。
   */
  const [root, setRoot] = useState(cwd);

  /*
    `open` / `close` 必须是恒定引用：`useExternalOpen` 拿它们当 effect 依赖，
    每次渲染都换一个新的会让那两个订阅反复重挂。所以最新值从 ref 读。
  */
  const latest = useRef({ selected, cwd, sessionId, hasUnsavedChanges, onOpened });
  latest.current = { selected, cwd, sessionId, hasUnsavedChanges, onOpened };
  const openedFromTerminal = useRef(false);

  const open = useCallback((path: string) => {
    const now = latest.current;
    if (path !== now.selected && now.hasUnsavedChanges() && !window.confirm(t.files.tree.switchDirtyConfirm)) return false;
    if (path !== now.selected) now.onOpened(path);
    /*
      只在「原来什么都没开」时记这一笔。已经开着的时候焦点在预览里、不在终端，
      这时候记下来会让关闭时把焦点抢回终端——而用户根本不是从那儿来的。
    */
    if (!now.selected) {
      openedFromTerminal.current = !!getTerminalHandle(now.sessionId)?.isInputTarget(document.activeElement);
    }
    setRoot(now.cwd);
    setSelected(path);
    return true;
  }, []);

  const close = useCallback(() => {
    // 从终端点进来的，关掉就把焦点还回去——不然用户得再点一下才能继续打字。
    if (openedFromTerminal.current) getTerminalHandle(latest.current.sessionId)?.focus();
    openedFromTerminal.current = false;
    setSelected(null);
  }, []);

  /** 改名要把选中跟着挪，否则高亮会留在一个已经不存在的路径上。 */
  const rename = useCallback((oldPath: string, newPath: string) => {
    setSelected((current) => {
      if (current === oldPath) return newPath;
      if (current?.startsWith(`${oldPath}/`)) return newPath + current.slice(oldPath.length);
      return current;
    });
  }, []);

  return { selected, root, open, close, rename };
}
