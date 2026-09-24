/*
  一个浮动窗口：标题栏 + 八个缩放把手 + 内容。

  **拖拽用 pointer 事件加 `setPointerCapture`，不是 mousemove + document 监听。**
  捕获之后指针离开窗口、甚至离开浏览器视口，事件照样送到这个元素，松手时一定会收到
  `pointerup`——而全局监听那套在指针飞出窗口时会丢掉 up，于是窗口「粘」在鼠标上，
  得再点一下才松开。同一套代码还顺带覆盖了触屏和手写笔。

  几何一律走 `geometry.ts` 的纯函数，这里只负责把指针位移喂进去。
*/
import { useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '@roost/i18n';
import { IconClose } from '../../shared/icons';
import { resizeRect, type Rect, type ResizeEdge, type Viewport } from './geometry';

const EDGES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'n', className: 'left-2 right-2 top-0 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'left-2 right-2 bottom-0 h-1.5 cursor-ns-resize' },
  { edge: 'w', className: 'top-2 bottom-2 left-0 w-1.5 cursor-ew-resize' },
  { edge: 'e', className: 'top-2 bottom-2 right-0 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 h-3 w-3 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize' },
];

type Props = {
  title: string;
  rect: Rect;
  shaded: boolean;
  maximized: boolean;
  front: boolean;
  viewport: Viewport;
  zIndex: number;
  onFocus: () => void;
  onRect: (rect: Rect) => void;
  onShade: () => void;
  onMaximize: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function FloatingWindow({ title, rect, shaded, maximized, front, viewport, zIndex,
  onFocus, onRect, onShade, onMaximize, onClose, children }: Props) {
  const m = t.misc.windows;
  const drag = useRef<{ pointer: number; startX: number; startY: number; origin: Rect; edge: ResizeEdge | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = (event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge | null) => {
    // 只认主键：右键要留给上下文菜单，中键是粘贴/自动滚动。
    if (event.button !== 0) return;
    event.preventDefault();
    onFocus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, origin: rect, edge };
    setBusy(true);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    /*
      位移始终相对**按下那一刻**的矩形算，不是相对上一帧累加。累加会把每一帧的裁剪
      误差叠起来：窗口顶到边界之后再往回拖，指针和窗口就错开了一截，越拖越歪。
    */
    onRect(current.edge
      ? resizeRect(current.origin, current.edge, dx, dy, viewport)
      : { ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setBusy(false);
  };

  /* 键盘也要能挪窗口——标题栏是可拖拽的，而拖拽在键盘上够不着。 */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.altKey ? 1 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const [dx, dy] = delta;
    onRect(event.shiftKey
      ? resizeRect(rect, 'se', dx, dy, viewport)
      : { ...rect, x: rect.x + dx, y: rect.y + dy });
  };

  const button = 'grid h-6 w-6 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text';
  return (
    <section
      aria-label={title}
      onPointerDown={onFocus}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: shaded ? undefined : rect.height, zIndex }}
      /*
        圆角从 lg 放大到 16px：浮动窗口是这个界面上唯一真正「浮在别的东西上面」的东西，
        圆角小了它就和底下那些贴边的面板长得一样，看不出层次。

        `raised` 给它微渐变和内描边高光，`shadow-modal` / `shadow-pop` 给「离底多远」——
        在最前那一张浮得更高。边框去掉：rim 已经在描边了，再叠一圈会变成两道线。
      */
      className={`raised absolute flex flex-col overflow-hidden rounded-2xl ${
        front ? 'shadow-modal' : 'shadow-pop'
      } ${busy ? 'select-none' : ''}`}
    >
      <header
        // 标题栏自己接管拖拽。双击等价于最大化/还原——那是所有窗口系统的共同习惯。
        onPointerDown={event => begin(event, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={onMaximize}
        onKeyDown={onKeyDown}
        tabIndex={0}
        title={m.moveHint}
        className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-border/60 bg-bg-raised px-2 active:cursor-grabbing"
      >
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-text">{title}</span>
        {/* 按钮上要 stopPropagation：否则按下去先触发标题栏的拖拽，点击变成一次零位移的拖动。 */}
        <button type="button" className={button} title={shaded ? m.unshade : m.shade}
          onPointerDown={event => event.stopPropagation()} onClick={onShade}>
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className={button} title={maximized ? m.restore : m.maximize}
          onPointerDown={event => event.stopPropagation()} onClick={onMaximize}>
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden><rect x="3.5" y="3.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
        </button>
        <button type="button" className={button} title={m.close}
          onPointerDown={event => event.stopPropagation()} onClick={onClose}><IconClose /></button>
      </header>
      {/* 卷起时内容整个不渲染，不是 `display:none`——面板里有轮询和订阅，留着会继续跑。 */}
      {!shaded && <div className="min-h-0 flex-1 overflow-hidden">{children}</div>}
      {!shaded && !maximized && EDGES.map(({ edge, className }) => (
        <span key={edge} role="presentation"
          onPointerDown={event => begin(event, edge)} onPointerMove={move}
          onPointerUp={end} onPointerCancel={end}
          className={`absolute ${className}`} />
      ))}
    </section>
  );
}
