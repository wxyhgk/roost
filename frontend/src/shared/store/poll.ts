export const WORKSPACE_POLL_INTERVAL_MS = 4000;
export const WORKSPACE_REQUEST_TIMEOUT_MS = 45000;

/** One read owns the slot until it settles, including after an abort request. */
export function createWorkspacePoller<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  onError: () => void;
  visible?: boolean;
}) {
  let visible = options.visible ?? true;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { controller: AbortController; timeout: ReturnType<typeof setTimeout> } | undefined;
  let refreshAfterFlight = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  /*
    **在途时的手动 `refresh()` 直接丢掉，不排队——这和隔壁那个轮询器不一样，是有意的。**

    `features/server-monitor/poll.ts` 形状几乎相同但会排一笔（`queued`）。一度想把两者并成
    一份，试过之后判断不该并：

    - 真正要紧的那条路**这里已经排队了**：`setVisible(true)` 撞上在途请求会置
      `refreshAfterFlight`，切回标签页一定拿得到新数据。手动 `refresh()` 只有一个调用点
      （`store/index.ts` 的 `pageshow`），而它绝大多数时候和可见性那条重合。
    - 丢掉的代价是至多多等一个轮询间隔（4 秒），而这是工作区数据，不是人盯着的读数；
      监控面板那边有个用户会去点的「刷新」按钮，点了没反应才是真问题，所以它排队。
    - 「间隔从完成那一刻起算」这条被 `workspace-poll.test.ts` 第一条用例明确钉着。改成
      排队会让那条红——我改过一次，就是它拦下来的。

    两个轮询器的差异不是重复，是两种不同的取舍；并成一份就得给其中一方加开关，
    那比留两份小文件更糟。
  */
  function refresh() {
    if (disposed || !visible || active) return;
    clearTimer();
    const controller = new AbortController();
    const flight = {
      controller,
      timeout: setTimeout(() => {
        controller.abort();
        if (!disposed) options.onError();
      }, WORKSPACE_REQUEST_TIMEOUT_MS),
    };
    active = flight;
    // Promise.resolve also makes a synchronous adapter failure follow the same cleanup path.
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return options.read(controller.signal);
    }).then(value => {
      if (!disposed && !controller.signal.aborted) options.apply(value);
    }).catch(() => {
      if (!disposed && !controller.signal.aborted) options.onError();
    }).finally(() => {
      clearTimeout(flight.timeout);
      active = undefined;
      if (disposed || !visible) return;
      if (refreshAfterFlight) {
        refreshAfterFlight = false;
        refresh();
      } else {
        timer = setTimeout(refresh, WORKSPACE_POLL_INTERVAL_MS);
      }
    });
  }

  refresh();
  return {
    refresh,
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      clearTimer();
      refreshAfterFlight = false;
      // Let an existing read finish when the tab hides. Waking requests one fresh read
      // after that flight, so an old pre-sleep request cannot delay the next poll interval.
      if (visible) {
        if (active) refreshAfterFlight = true;
        else refresh();
      }
    },
    dispose() {
      disposed = true;
      clearTimer();
      if (active) {
        clearTimeout(active.timeout);
        active.controller.abort();
      }
    },
  };
}
