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
