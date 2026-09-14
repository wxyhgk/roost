// 「会话安静下来了」在三个地方各有一个门槛，故意不同，放在一起是为了改的时候一眼看全。
// 点变灰早于显示时长；静默时长不再触发任务完成提醒。
//
//  3 秒  QUIET_STATE_AFTER_MS，定义在 @roost/terminal-protocol，因为它是状态帧上的一个字段
//        （quietAfterMs），前后端都要认。它决定会话行那个小圆点是绿还是灰，回答的是
//        「此刻还在刷屏吗」，所以必须短。前端只消费后端算好的 state，不重算。
// 10 秒  会话行上「静默 X」的显示门槛。AI 输出里几秒的停顿太常见，写出来只是噪音。
//
// 曾经还有第三个门槛（30 秒的「旧版静默回调」）。那条回调链已经整个删掉了：它的出口
// onQuietSession 从来没有消费者，完成提示走的是 quietNotify.ts 那条（认 AI 的 done 状态）。

export { QUIET_STATE_AFTER_MS } from '@roost/terminal-protocol';

export const QUIET_LABEL_AFTER_MS = 10_000;
