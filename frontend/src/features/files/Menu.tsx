import {
  FloatingFocusManager, FloatingList, FloatingPortal, autoUpdate, flip, offset, shift,
  useDismiss, useFloating, useInteractions, useListItem, useListNavigation, useRole,
} from "@floating-ui/react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 右键菜单的外壳：定位、键盘导航、点外面关掉、Esc 关掉。
 *
 * 树上有两个菜单——点在条目上的，和点在空白处的——它们的菜单项毫无重叠，但**关掉的
 * 规矩和定位的算法必须一模一样**。抄一份的话，以后修其中一个只会修到一个。
 *
 * 定位交给 floating-ui。原来是自己量盒子再 `Math.min` 夹回视口，那有两个毛病：
 *
 *   - 夹回去意味着在窗口底部右键时菜单**向上滑动、盖住光标**。正确的做法是翻到光标
 *     上方（`flip`），而不是压着它。
 *   - 只考虑了视口。滚动容器、窗口缩放都得自己再补一遍。
 *
 * 顺带拿到了键盘导航：上下键、Home/End、循环。之前这个菜单只能用鼠标点。
 */

type MenuContext = {
  activeIndex: number | null;
  getItemProps: ReturnType<typeof useInteractions>["getItemProps"];
};
const Ctx = createContext<MenuContext | null>(null);
function useMenu() {
  const value = useContext(Ctx);
  if (!value) throw new Error("MenuItem 必须放在 Menu 里面");
  return value;
}

export function Menu({ x, y, onClose, children }: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const labelsRef = useRef<Array<string | null>>([]);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: open => { if (!open) onClose(); },
    // 右键菜单的惯例是从光标往右下展开；放不下时由 flip 换边，而不是压住光标。
    placement: "right-start",
    /*
      必须是 fixed，不是 floating-ui 默认的 absolute：菜单从属于文件树，而树在一个
      `overflow-auto` 的容器里，absolute 会被那层裁掉半截。虚拟锚点给的是视口坐标
      （clientX/clientY），和 fixed 天然对得上。
    */
    strategy: "fixed",
    middleware: [offset({ mainAxis: 2, crossAxis: 2 }), flip({ fallbackAxisSideDirection: "end" }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // 锚点是**光标那个点**而不是某个元素，所以用一个零尺寸的虚拟参照物。
  useEffect(() => {
    refs.setPositionReference({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) });
  }, [x, y, refs]);

  const dismiss = useDismiss(context, {
    // 用 pointerdown 而不是 click：按下就关，和原来的行为一致，也避免「按下时在菜单
    // 外、松开时在菜单里」这种拖选被误判成点了菜单项。
    outsidePressEvent: "pointerdown",
  });
  const role = useRole(context, { role: "menu" });
  const listNavigation = useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true });
  const { getFloatingProps, getItemProps } = useInteractions([dismiss, role, listNavigation]);

  return (
    /*
      挂到 body 上：fixed 只在没有 transform 祖先时才真的脱离，而文件树上方是一串
      带 transform 的面板容器。portal 之后既不怕裁剪也不怕层叠上下文。
    */
    <FloatingPortal>
      {/*
        initialFocus={-1}：打开时焦点落在菜单本身而不是第一项——和系统右键菜单一致，
        按下方向键才开始选。modal={false}：轻量浮层，不该把焦点锁死在里面。
      */}
      <FloatingFocusManager context={context} initialFocus={-1} returnFocus modal={false}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="z-50 w-52 rounded-lg border border-border bg-bg-raised p-1.5 shadow-modal"
          {...getFloatingProps({ onContextMenu: event => event.preventDefault() })}
        >
          <Ctx.Provider value={{ activeIndex, getItemProps }}>
            <FloatingList elementsRef={listRef} labelsRef={labelsRef}>{children}</FloatingList>
          </Ctx.Provider>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

export function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  const { activeIndex, getItemProps } = useMenu();
  // useListItem 把自己登记进 FloatingList，索引由挂载顺序决定。分隔线不登记，所以
  // 方向键不会停在它上面。
  const { ref, index } = useListItem({ label });
  const active = activeIndex === index;
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      // 只有当前项可 Tab 到：整组菜单项在 Tab 序列里算一站，内部移动交给方向键。
      tabIndex={active ? 0 : -1}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-body hover:bg-bg-hover ${
        active ? "bg-bg-hover" : ""
      } ${danger ? "text-danger" : "text-text"}`}
      {...getItemProps({ onClick })}
    >
      {label}
    </button>
  );
}

export const MenuSeparator = () => <div role="separator" className="my-1 h-px bg-border" />;
