import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 右键菜单的外壳：定位、点外面关掉、Esc 关掉。
 *
 * 树上有两个菜单——点在条目上的，和点在空白处的——它们的菜单项毫无重叠，但**关掉的
 * 规矩和定位的算法必须一模一样**。抄一份的话，以后修其中一个（比如下面那个量高度的
 * 毛病）只会修到一个。
 */
export function Menu({ x, y, onClose, children }: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /*
    位置要**量出来**，不能照菜单有几项去估。

    原来写的是 `Math.min(y, innerHeight - 110)`，110 是照着当时两项菜单拍的数字；
    菜单长到七八项之后，在窗口底部右键就会有半截掉到屏幕外，而且是那种只在特定
    位置出现、平时完全看不见的毛病。量真实高度就没有可拍错的常数。

    useLayoutEffect 里改位置，浏览器在这中间不绘制，所以看不到跳。
  */
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-52 rounded-lg border border-border bg-bg-raised p-1.5 shadow-modal"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

export function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-body hover:bg-bg-hover ${
        danger ? "text-danger" : "text-text"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export const MenuSeparator = () => <div role="separator" className="my-1 h-px bg-border" />;
