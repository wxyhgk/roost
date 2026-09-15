import { useEffect, useState, type ReactNode } from "react";

/**
 * 高度折叠。原来这件事由 framer-motion 的 `AnimatePresence + height: auto` 做，
 * 而那是全项目**唯一**需要它的地方——为了这一处动画，首屏要背 381 KB（raw）的
 * motion-dom + framer-motion。换成 CSS 之后那 381 KB 整包消失。
 *
 * CSS 本身没法从 0 过渡到 auto，`grid-template-rows: 0fr → 1fr` 是绕过这一点的
 * 标准写法：外层是单行 grid，行高按比例插值，内层 `min-h-0` 才肯被压到 0 以下
 * （grid 项的默认 min-height 是 auto，不写这句就压不动）。
 *
 * **收起时 children 要留到动画结束才卸载**，这一点必须和原来一致：侧栏的会话行
 * 各自登记了 dnd-kit 的 droppable，提前卸载会让收起的瞬间落点凭空消失。反过来也
 * 不能常驻——常驻等于让收起的行一直当着拖拽落点。
 */
const DURATION = 180;

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  // 只在「收起动画还没跑完」时为真；展开期间 open 自己就够了。
  const [tail, setTail] = useState(open);

  useEffect(() => {
    if (open) {
      setTail(true);
      return;
    }
    /*
      用定时器而不是 transitionend：宿主在 display:none 里（比如侧栏整个收起来了）
      时过渡根本不会跑，那个事件也就永远不来，children 会卡在树上再也卸不掉。
    */
    const timer = window.setTimeout(() => setTail(false), DURATION);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      className="grid transition-[grid-template-rows] duration-[180ms] ease-in-out"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div
        className={`min-h-0 overflow-hidden transition-opacity duration-[180ms] ease-in-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
      >
        {(open || tail) && children}
      </div>
    </div>
  );
}
