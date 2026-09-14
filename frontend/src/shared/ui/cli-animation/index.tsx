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


/**
 * 把 viewBox 收到内容的真实边界上。
 *
 * 这些动画的画布是 1080×1080，而 logo 只占中间一小块——Claude 那份约 35%。静态图标是
 * `viewBox="0 0 24 24"` 贴边裁的，所以同样 28px 的槽位里动画看着只有十来个像素，明显比
 * 旁边的小一圈。
 *
 * **不写死放大倍数**：两份动画的留白比例本来就不一样，以后再加一份又是另一个数。让它
 * 自己 `getBBox()` 量，对任何素材都成立。
 *
 * 取多帧的**并集**而不是只看第一帧：logo 动画常常在画面里平移或缩放，只按首帧裁会在后面
 * 几帧被切掉一角。采样几帧足够，代价是挂载时几次 getBBox。
 */
function cropToContent(host: HTMLElement, animation: { goToAndStop(value: number, isFrame?: boolean): void; play(): void; totalFrames: number }) {
  const svg = host.querySelector('svg');
  if (!svg) return;
  let box: { x: number; y: number; right: number; bottom: number } | null = null;
  try {
    for (let i = 0; i < 8; i++) {
      animation.goToAndStop(Math.round(animation.totalFrames * i / 8), true);
      const frame = svg.getBBox();
      if (!frame.width || !frame.height) continue;
      box = box
        ? { x: Math.min(box.x, frame.x), y: Math.min(box.y, frame.y),
            right: Math.max(box.right, frame.x + frame.width), bottom: Math.max(box.bottom, frame.y + frame.height) }
        : { x: frame.x, y: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height };
    }
  } catch { /* getBBox 在元素还没布局时会抛；那就保持原样，只是小一点，不是坏掉。 */ }
  animation.goToAndStop(0, true);
  animation.play();
  if (!box) return;
  const square = squareViewBox(box);
  svg.setAttribute('viewBox', `${square.x} ${square.y} ${square.size} ${square.size}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

/**
 * 把内容包围盒撑成正方形，内容居中。
 *
 * 槽位是正方形的，直接用非方形的包围盒当 viewBox 会让 logo 被拉变形。按长边取、短边
 * 两侧各补一半，这样宽高比不变。
 */
export function squareViewBox(box: { x: number; y: number; right: number; bottom: number }) {
  const width = box.right - box.x, height = box.bottom - box.y;
  const size = Math.max(width, height);
  return { x: box.x - (size - width) / 2, y: box.y - (size - height) / 2, size };
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
    let animation: ReturnType<Awaited<ReturnType<typeof loadPlayer>>['loadAnimation']> | undefined;
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
      cropToContent(host.current, animation);
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
