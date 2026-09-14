import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * AI 正在回复时，把静态图标换成动的。
 *
 * **首屏一个字节都不加。** 播放器（lottie_light，45.6 KB gzip）和动画数据都是动态
 * import 的，只有真的有人在回复时才去拉。加载完之前渲染 `children`——也就是原来那个
 * 静态图标，所以既不闪也不跳，失败了就一直是它。
 *
 * 只认内置的 claude / codex：`resolveCliIdentity` 给的 `builtin` 对用户自定义的 CLI 是
 * null，不会误动别人的图标。
 */
const ANIMATIONS: Record<string, () => Promise<{ default: unknown }>> = {
  claude: () => import('./claude.json'),
  codex: () => import('./codex.json'),
};

/** 纯判断，不触发任何加载——调用方用它决定要不要挂这个组件。 */
export const hasCliAnimation = (builtin: string | null): boolean => !!builtin && builtin in ANIMATIONS;

/*
  播放器只装载一次，全应用共用。每个图标各自 loadAnimation，但那 45.6 KB 的库和每份
  动画数据都只走一次网络。
*/
let playerPromise: Promise<typeof import('lottie-web/build/player/lottie_light')['default']> | null = null;
const loadPlayer = () => (playerPromise ??= import('lottie-web/build/player/lottie_light').then(m => m.default));
const dataCache = new Map<string, Promise<unknown>>();
function loadData(builtin: string) {
  const cached = dataCache.get(builtin);
  if (cached) return cached;
  const promise = ANIMATIONS[builtin]().then(m => m.default);
  dataCache.set(builtin, promise);
  return promise;
}

/** 系统里关掉了动效就别动。这是设置项，运行时可能改，所以订阅而不是读一次。 */
function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function CliAnimation({ builtin, className, label, children }: {
  builtin: string;
  className?: string;
  label: string;
  /** 动画就位之前、以及任何原因用不了时显示的东西。 */
  children: ReactNode;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    let animation: { destroy(): void } | undefined;
    let cancelled = false;
    void Promise.all([loadPlayer(), loadData(builtin)]).then(([player, animationData]) => {
      // 两次 await 之间组件可能已经卸载，或者这个会话已经回复完了。
      if (cancelled || !host.current) return;
      animation = player.loadAnimation({
        container: host.current,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData,
      });
      setReady(true);
    }).catch(() => { /* 拉不到就一直用静态图标，不值得打扰用户。 */ });
    return () => {
      cancelled = true;
      // 必须销毁：lottie 自己挂着 rAF 循环，不销毁就是每个关掉的会话都留一个在跑。
      animation?.destroy();
      setReady(false);
    };
  }, [builtin, reduced]);

  if (reduced) return <>{children}</>;
  return (
    <span role="img" aria-label={label} title={label} className={className}>
      {/* 就位之前把静态图标摆在原地，避免先空一块再跳出来。 */}
      {!ready && children}
      <span ref={host} className={ready ? 'block h-full w-full' : 'hidden'} />
    </span>
  );
}
