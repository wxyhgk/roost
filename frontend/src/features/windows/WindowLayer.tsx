/*
  窗口层：所有浮动窗口都画在这里。

  **它铺在主布局之上，但不挤占主布局。** roost 的原则是终端始终在那儿，窗口浮在上面；
  所以这一层是 `absolute inset-0 pointer-events-none`，只有窗口自己接收指针事件——
  空白处点下去应该落到底下的终端上，而不是被一块透明的板子挡住。

  视口取的是**这一层自己的尺寸**，不是 `window.innerWidth`：它下面还有顶栏和状态栏，
  按整页算的话窗口能被拖到状态栏底下去，再也看不见。

  **窗口里放什么由调用方给。** 这一层不 import `app/RightPanel`——那是组合层，特性不
  许反过来依赖它（check-boundaries 里那条 "a feature must not depend on the app
  composition layer"，第一版就是这么写的，当场被拦下）。所以内容和标题都从 props 进来，
  依赖方向保持 app → feature。以后启动台要往窗口里塞 iframe，也走同一个口子。
*/
import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '@roost/i18n';
import { ErrorBoundary } from '../../shared/ui/ErrorBoundary';
import { closeWindow, focusWindow, restoreWindows, setRect, setViewport, toggleMaximize, toggleShade, useWindowState, type WindowContent } from './store';
import { FloatingWindow } from './FloatingWindow';

export function WindowLayer({ titleOf, renderContent }: {
  titleOf: (content: WindowContent) => string;
  renderContent: (content: WindowContent, visible: boolean) => ReactNode;
}) {
  const { windows, order, viewport } = useWindowState();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    restoreWindows({ width: element.clientWidth, height: element.clientHeight });
    /*
      用 ResizeObserver 而不是 window 的 resize 事件：这一层的大小还会因为**收起侧栏**
      或拖动分栏而变，那些不触发 window resize，而窗口照样会落到新边界外面。
    */
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} aria-label={t.misc.windows.region} className="pointer-events-none absolute inset-0 overflow-hidden">
      {windows.map(window => {
        const index = order.indexOf(window.id);
        const title = titleOf(window.content);
        return (
          <div key={window.id} className="pointer-events-auto contents">
            {/*
              每个窗口单独一个 ErrorBoundary：一个面板炸掉只让那一个窗口降级，
              不能把整层窗口一起带走——那会让人以为窗口系统本身坏了。
            */}
            <ErrorBoundary region={title}>
              <FloatingWindow
                title={title}
                rect={window.rect} shaded={window.shaded} maximized={!!window.restore}
                front={index === order.length - 1} viewport={viewport}
                // 层叠顺序就是数组下标，不存 z-index 数字。理由见 geometry.ts 的 raise。
                zIndex={10 + index}
                onFocus={() => focusWindow(window.id)}
                onRect={rect => setRect(window.id, rect)}
                onShade={() => toggleShade(window.id)}
                onMaximize={() => toggleMaximize(window.id)}
                onClose={() => closeWindow(window.id)}
              >
                {renderContent(window.content, !window.shaded)}
              </FloatingWindow>
            </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
