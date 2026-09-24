/*
  打开着哪些窗口、各自在哪儿、谁在最前。

  **单独一个小 store，没有并进 `shared/store`。** 那个 reducer 管的是工作区（会话、
  分组、选中项），要经后端持久化；窗口位置是**这台设备这个浏览器**的观感状态，另一台
  设备上打开同一个 roost 时不该继承过来。两者的生命周期和存储位置都不一样，混在一起
  只会让那个 reducer 更难改。

  用 `useSyncExternalStore`：任何地方（右侧面板的按钮、命令面板、以后的启动台）都能
  开窗口，不用一路传 props。
*/
import { useSyncExternalStore } from 'react';
import type { RightView } from '../../shared/view';
import { cascadeRect, clampToViewport, maximizedRect, raise, reflow, type Rect, type Viewport } from './geometry';

/** 窗口里放什么。现在只有右侧面板那几个视图；启动台做出来之后这里会多一个 `app`。 */
export type WindowContent = { kind: 'panel'; view: RightView };

export type WindowState = {
  id: string;
  content: WindowContent;
  rect: Rect;
  /** 卷起：只剩标题栏。**不是最小化**——最小化要有个任务栏才能还原，卷起不用。 */
  shaded: boolean;
  /** 最大化前的位置，还原时用。没有最大化时是 null。 */
  restore: Rect | null;
};

type State = { windows: WindowState[]; order: string[]; viewport: Viewport };

const STORAGE_KEY = 'roost.windows.v1';

let state: State = { windows: [], order: [], viewport: { width: 1200, height: 800 } };
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/*
  存 localStorage，不存后端。

  **每一次读写都包 try/catch**：无痕窗口、站点数据被清、以及某些浏览器在第三方上下文
  里会让 `localStorage` 直接抛，而不是返回 null。这一层挂掉时窗口系统必须照常工作，
  只是不记位置——它是便利，不是功能。
*/
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      { windows: state.windows, order: state.order }));
  } catch { /* 记不住位置就算了，不能因此让窗口开不出来。 */ }
}

/** 读回上次的窗口。形状对不上就整份丢弃——半个坏掉的窗口比没有窗口更难查。 */
export function restoreWindows(viewport: Viewport) {
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { return; }
  if (!saved || typeof saved !== 'object') return;
  const { windows, order } = saved as { windows?: unknown; order?: unknown };
  if (!Array.isArray(windows) || !Array.isArray(order)) return;
  const valid = windows.filter((window): window is WindowState =>
    !!window && typeof window === 'object'
    && typeof (window as WindowState).id === 'string'
    && !!(window as WindowState).rect
    && typeof (window as WindowState).rect.x === 'number');
  state = {
    viewport,
    // 存下来的位置是上次那块视口下的；这次可能换了设备。一律重新裁剪。
    windows: reflow(valid, viewport),
    order: order.filter((id): id is string => typeof id === 'string' && valid.some(window => window.id === id)),
  };
  emit();
}

export function setViewport(viewport: Viewport) {
  if (viewport.width === state.viewport.width && viewport.height === state.viewport.height) return;
  state = { ...state, viewport, windows: reflow(state.windows, viewport) };
  emit(); persist();
}

/**
 * 打开一个窗口；同一份内容已经开着就把它提到最前，不再开第二个。
 *
 * 「已经开着还再开一个」看起来像是更听话，实际上是把同一块内容复制成两份各自滚动、
 * 各自加载的副本，而人想要的只是「把它拿到前面来」。
 */
export function openWindow(content: WindowContent) {
  const existing = state.windows.find(window => window.content.kind === content.kind
    && window.content.view === content.view);
  if (existing) { focusWindow(existing.id); return existing.id; }
  const id = `w_${content.view}_${Date.now().toString(36)}`;
  const window: WindowState = {
    id, content, shaded: false, restore: null,
    rect: cascadeRect(state.windows.map(other => other.rect), state.viewport),
  };
  state = { ...state, windows: [...state.windows, window], order: [...state.order, id] };
  emit(); persist();
  return id;
}

export function closeWindow(id: string) {
  state = { ...state, windows: state.windows.filter(window => window.id !== id),
    order: state.order.filter(other => other !== id) };
  emit(); persist();
}

export function focusWindow(id: string) {
  const order = raise(state.order, id);
  if (order.length === state.order.length && order.every((value, i) => value === state.order[i])) return;
  state = { ...state, order };
  emit(); persist();
}

function update(id: string, change: (window: WindowState) => WindowState) {
  state = { ...state, windows: state.windows.map(window => window.id === id ? change(window) : window) };
  emit(); persist();
}

/** 拖动/缩放的结果。调用方已经过了 geometry 那一层，这里只负责落库。 */
export function setRect(id: string, rect: Rect) {
  update(id, window => ({ ...window, rect: clampToViewport(rect, state.viewport), restore: null }));
}

export function toggleShade(id: string) {
  update(id, window => ({ ...window, shaded: !window.shaded }));
}

export function toggleMaximize(id: string) {
  update(id, window => window.restore
    ? { ...window, rect: clampToViewport(window.restore, state.viewport), restore: null }
    // 记下现在的位置再铺满：还原要回到人自己摆的地方，不是回到一个默认值。
    : { ...window, restore: window.rect, rect: maximizedRect(state.viewport), shaded: false });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;
export const useWindowState = () => useSyncExternalStore(subscribe, snapshot, snapshot);
