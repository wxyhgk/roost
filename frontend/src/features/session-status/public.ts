/**
 * 会话状态特性对外的**唯一**入口。照着 `features/terminal/public.ts` 那条规矩来：
 * 特性外部只准从这里进，特性内部各模块直接互相 import，不必绕这里转一道。
 *
 * 收口的理由不是整齐。在此之前外面有 14 处 import，直接摸进 7 个内部文件
 * （runtime / badge / quietNotify / quietThresholds / useQuietFor / useSessionActivity /
 * useGroupActivity）——也就是说这个特性的每一次内部重命名都可能碰到 terminal、workspace、
 * conversations 三个特性加 app。terminal 早就收口了，5 个外部消费者无一例外走公开入口，
 * 这边只是补上同一条纪律。
 *
 * **桶文件是有代价的，这里量过再收的**：`features/terminal/activity.ts` 原来只从
 * `quietThresholds.ts`（一个无依赖的常量叶子）取一个数字，改走这里之后，源码层面它就牵上了
 * React 和整个 status runtime。产物上 rollup 摇得干净——实测首屏 main chunk
 * 245.6 → 245.0 KB gz，raw 853.3 KB 一字节未变。
 *
 * 也就是说这条收口是白拿的。但前提是这些模块保持可摇：谁要在这里再导出一个带顶层副作用的
 * 东西，代价就会从 0 变成真的。要是哪天首屏无端涨了，先回来看这一段。
 */

export { sessionStatus, startSessionStatus } from './runtime';
export { sessionBadge } from './badge';
export { useAgentNotify } from './quietNotify';
export { useSessionActivity } from './useSessionActivity';
export { useGroupActivity } from './useGroupActivity';
export { useQuietFor } from './useQuietFor';
