/*
  打字时等一下再搜。

  xterm 的查找在**未命中**时会扫整个缓冲区——20000 行回滚 × 140 列约 280 万字符，而它的
  行缓存被 `onLineFeed` / `onCursorMove` 不停清掉，活着的终端一直在触发这三个，所以逐键
  之间基本拿不到复用，每次都要重新把行翻成字符串。

  于是打一个**不存在**的词最难受：每敲一个字符主线程就卡一下，输入框里的字都跟不上手。
  而那几次中间结果谁也不看——人要的是打完之后的那一次。

  这个模块只管「什么时候真的去搜」，不碰终端也不碰 DOM，所以能单独测。
*/

/**
 * 连打之间等多久。
 *
 * 挑在「一次按键的间隔」和「人开始觉得没反应」之间：连打时只在停下来那一刻搜一次，
 * 停下来之后又快到察觉不出延迟。
 */
export const TYPING_PAUSE_MS = 120;

type Timers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SearchScheduler = {
  /** 打字。攒一下再搜；空串立刻清。 */
  type(query: string): void;
  /** 回车、上下箭头。**不等**——那是「现在就要结果」的明确动作。 */
  now(query: string, direction: 1 | -1): void;
  /** 收起查找、换终端、卸载。把等着的那一次取消掉。 */
  cancel(): void;
};

export function createSearchScheduler({ search, onPending, delay = TYPING_PAUSE_MS, timers = globalThis }: {
  search(query: string, direction: 1 | -1): void;
  /**
   * 有一次搜索正在等待触发。
   *
   * 界面拿它把上一次的「未找到」收掉：词已经变了，旧结论对它不成立，留着会在一个正确的
   * 词上闪一下红字。
   */
  onPending?(): void;
  delay?: number;
  timers?: Timers;
}): SearchScheduler {
  let pending: unknown;
  const cancel = () => { timers.clearTimeout(pending); pending = undefined; };
  return {
    cancel,
    now(query, direction) { cancel(); search(query, direction); },
    type(query) {
      cancel();
      // 空串立刻清：清除是常数时间的，而且留着上一次的高亮会让人以为还在搜。
      if (!query) { search(query, 1); return; }
      onPending?.();
      pending = timers.setTimeout(() => { pending = undefined; search(query, 1); }, delay);
    },
  };
}
