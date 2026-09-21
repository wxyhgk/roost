/*
  「这一帧真的出现在用户眼前了吗」——已读回执。

  这一摊原来长在 `sessionController` 那个 84 行的匿名 IIFE 里，和挂载、回显预测、连接、
  尺寸观察挤在一起。**搬出来的判据和 `resizeGate` 一样：它自己拥有状态。** 缓存那一位
  （`presented`）和在途的 afterPaint 回调（`pending`）只有这里读写；其余一律靠注入的能力拿。

  这里有一条很容易在重构中被抹掉的正确性约束，见 `rendered()` 里的注释。
*/

export type ReadReceipts = {
  /** 终端画完了一帧。每帧都会调，所以这条路上不许有强制 layout。 */
  rendered(): void;
  /** 「画出来了吗」这个答案可能变了：切前后台、容器尺寸变、标签页或窗口焦点变。 */
  forget(): void;
  /** 取消所有在途回调。 */
  dispose(): void;
};

export function createReadReceipts({ ready, isPresented, afterPaint, report, instance, seq }: {
  /** 除「画出来了」之外的全部条件：会话有效、前台、贴着底、输入已开、页面可见、窗口有焦点。 */
  ready(): boolean;
  /** 问一次 DOM。**贵**，所以这里给它加了缓存，见下。 */
  isPresented(): boolean;
  /** 下一次绘制之后回调。返回取消函数。宿主不提供时整条已读回执就不工作。 */
  afterPaint?(callback: () => void): () => void;
  report?(instanceId: string, seq: number): void;
  /** 当前活着的实例。换实例时它会变，这正是下面那条约束要比的东西。 */
  instance(): string | null;
  /** 已经落到终端上的序号。还没有 resume 时给 null。 */
  seq(): number | null;
}): ReadReceipts {
  /*
    「这一屏真的被画出来了吗」——缓存它，**别每帧都问 DOM**。

    `isPresented()` 在宿主那边是 `getClientRects()` 加 `getComputedStyle()`，一个强制
    layout、一个强制 style recalc。而它挂在 `canRead()` 里，`canRead()` 由 `term.onRendered`
    **每一帧**调一次，命中后 `afterPaint` 里还会再调一次。执行时机还格外糟：那一刻 xterm
    刚写完行的 DOM，layout 必然是脏的，浏览器只能同步重算整个终端子树——刷屏时整个界面
    发涩的主因之一。

    这个答案其实很少变，而且它**每一种变法我们都收得到信号**：
    - 前后台切换 → `setActive`（隐藏用的是 `visibility`，不改布局，只能靠这个）
    - 容器尺寸变了（收面板、拖分隔条、display:none）→ ResizeObserver
    - 标签页前后台、窗口焦点 → visibilitychange / focus / blur

    所以改成「失效即重算」：这些信号来时把缓存清掉（`forget()`），下一次用到再问一遍 DOM。
  */
  let cache: boolean | null = null;
  const presented = () => {
    if (cache === null) cache = isPresented();
    return cache;
  };
  /** 在途的 afterPaint 取消函数。拆掉时必须一个不剩地取消，否则回调会打到已经死掉的会话上。 */
  const pending = new Set<() => void>();

  const canRead = () => ready() && presented();

  return {
    rendered() {
      /*
        `ready()` 先问，`presented()` 是带缓存的第二问——这个顺序是性能的全部：绝大多数
        帧在 `ready()` 里就被挡掉，根本走不到 DOM。
      */
      if (!canRead() || !afterPaint) return;
      /*
        **只认这一帧代表的那个光标位置。**

        `seq` 在这里就取走，而不是等到 afterPaint 回调里再取。否则在这两个时刻之间到达的
        新帧会被连带标成已读——而它还没有出现在屏幕上过。回执一旦报出去就收不回来，对面
        看到的是「对方已读」，但用户其实什么都没看见。

        实例也一样：绘制和 afterPaint 之间可能已经换了一个实例，那一帧属于旧的那个。
      */
      const at = instance();
      const applied = seq();
      if (at === null || applied === null) return;
      const cancel = afterPaint(() => {
        pending.delete(cancel);
        if (canRead() && instance() === at) report?.(at, applied);
      });
      pending.add(cancel);
    },
    forget() { cache = null; },
    dispose() {
      for (const cancel of pending) cancel();
      pending.clear();
    },
  };
}
