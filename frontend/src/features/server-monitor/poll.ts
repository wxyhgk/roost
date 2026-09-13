/** Schedule from completion; closing/hiding the panel cancels work. */
export function startMonitorPolling<T>(options: {
  read(signal: AbortSignal): Promise<T>; data(value: T): void; error(error: unknown): void;
  visible?: boolean; interval?: number; timeout?: number;
}) {
  let disposed = false, visible = options.visible ?? true, queued = false;
  let flight: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function refresh() {
    if (disposed || !visible) return;
    clearTimeout(timer);
    if (flight) { queued = true; return; }
    const controller = new AbortController(); flight = controller;
    deadline = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), options.timeout ?? 12000);
    void Promise.resolve().then(() => options.read(controller.signal)).then(value => {
      if (!disposed && !controller.signal.aborted) options.data(value);
    }).catch(error => {
      if (!disposed && visible && (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError')) options.error(error);
    }).finally(() => {
      clearTimeout(deadline); flight = null;
      if (disposed || !visible) return;
      if (queued) { queued = false; refresh(); }
      else timer = setTimeout(refresh, options.interval ?? 5000);
    });
  }
  refresh();
  return {
    refresh,
    visible(value: boolean) {
      if (value === visible || disposed) return;
      visible = value; clearTimeout(timer); queued = false;
      if (visible) refresh(); else { clearTimeout(deadline); flight?.abort(); }
    },
    dispose() { disposed = true; clearTimeout(timer); clearTimeout(deadline); flight?.abort(); },
  };
}
