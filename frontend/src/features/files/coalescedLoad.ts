/**
 * 「在途就排队，不打断」的取数器。
 *
 * 文件面板有两种重新取数的理由，处理方式相反：
 *
 * - **导航**（换目录、换根）：之前那个结果已经没人要了，当场打断。留着它只会占住
 *   连接，并在慢链路上排在新请求前面。这一层由调用方负责——换身份就 `dispose()`
 *   旧的、建一个新的。
 * - **刷新**（文件变化通知）：想要的是同一份数据的最新版本。在途时**不打断**，
 *   记一笔，等它自己回来再取一次；期间来多少次刷新都合并成一次。
 *
 * 为什么不用去抖：去抖要猜一个毫秒数，而正确的间隔取决于实际往返时间。本机上
 * 应该每次都刷，330ms 的远程链路上应该合并——排队让它自己按 RTT 调，没有常数可猜错。
 *
 * 不这么做的后果是实测过的：后端文件监听去抖 150ms，终端里跑一次构建时事件流约
 * 6.7 帧/秒，而单程 330ms。原来的「一来通知就打断重发」意味着**每个响应都在到达前
 * 被下一帧掐掉**，整个构建期间树一次都不更新，纯烧带宽。
 *
 * 抽成模块而不是留在 effect 里，是因为这段逻辑值得有测试：它的错误形态是「偶尔少刷
 * 一次」或「疯狂重发」，两者在开发机上都看不出来。
 */
export type CoalescedLoad = {
  /** 取一次。在途时只记一笔，等当前这次结束后自动再取。 */
  load(): void;
  /** 作废：中止在途请求，之后的回调一律不再发生。 */
  dispose(): void;
};

export function createCoalescedLoad<T>(
  run: (signal: AbortSignal) => Promise<T>,
  on: {
    /** 每次真正发起之前。清错误、起「太慢了」的计时器之类。 */
    start?(): void;
    data(value: T): void;
    error(reason: unknown): void;
    /** 每次结束（成功或失败）之后，且**这一批已经没有排队的刷新**时才调。 */
    settled?(): void;
  },
): CoalescedLoad {
  const abort = new AbortController();
  let alive = true;
  let running = false;
  let queued = false;

  const load = () => {
    if (!alive) return;
    if (running) { queued = true; return; }
    running = true;
    on.start?.();
    run(abort.signal)
      .then((value) => { if (alive) on.data(value); })
      .catch((reason: unknown) => { if (alive) on.error(reason); })
      .finally(() => {
        running = false;
        if (!alive) return;
        // 还有排队的就接着取，中间不报「结束」——对界面来说这一批还没完。
        if (queued) { queued = false; load(); return; }
        on.settled?.();
      });
  };

  return {
    load,
    dispose() {
      if (!alive) return;
      alive = false;
      queued = false;
      abort.abort();
    },
  };
}
