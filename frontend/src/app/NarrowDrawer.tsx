import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
  窄屏时盖在终端上的侧栏抽屉。

  **为什么是覆盖层而不是把面板拉宽**：骨架的三段是按百分比分的，手机 390px 去掉两条图标栏
  只剩 310，左面板 23% 就是 [实测] 72px 的一条竖缝。而把它调宽会把中间的终端挤窄 →
  `fit` 重算 → PTY resize → **SIGWINCH**，`tasks/terminal-flood/README.md` 里写着 omp 收到
  SIGWINCH 会把整段对话重新打印一遍。**覆盖层不改终端宽度，所以它不是更好看，是唯一不触发
  这条链的做法。**

  **为什么是 `<dialog>` 而不是一个绝对定位的 div**：`showModal()` 之后 Esc 和**安卓返回键**
  都由 CloseWatcher 统一处理，不用自己去 push history；焦点也被关在抽屉里。这是白送的。
  （Theia 至今开着的那个移动端 issue，第三条就是「上下文菜单打开后只能刷新页面才关得掉」。）

  **必须有可见的关闭入口，不能只靠手势。** Obsidian 手机版的右抽屉没有按钮、只能从边缘滑，
  论坛里长期有人报「右边栏在手机上用不了」——纯手势等于功能不存在。顶栏那两个箭头就是入口，
  这里再给一个遮罩点击关闭。
*/
export function NarrowDrawer({ side, label, onClose, children }: {
  side: "left" | "right";
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={label}
      onCancel={event => { event.preventDefault(); onClose(); }}
      // 点遮罩关闭：`<dialog>` 自己就是那块遮罩，点在它身上（而不是内容上）才算。
      onClick={event => { if (event.target === dialog.current) onClose(); }}
      className={`m-0 h-full max-h-none w-[86%] max-w-[420px] border-0 bg-bg-panel p-0 text-text backdrop:bg-black/50 ${
        side === "left" ? "mr-auto" : "ml-auto"}`}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">{children}</div>
    </dialog>,
    document.body);
}
