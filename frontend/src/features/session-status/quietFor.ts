// 会话行上的「静默了多久」。
//
// lastOutputAt 是后端进程 Date.now() 记下的一个绝对时间戳（backend/src/session-status.ts），
// 语义是「这个 PTY 最后一次吐字节的时刻」——不代表 AI 完成或在等待确认。
// 本机单用户工具，前后端共用同一个系统时钟，所以直接相减是安全的；
// 换成跨机器部署时这个前提就不成立了。
//
// 显示门槛见 quietThresholds.ts，那里同时记着另外两个相关的阈值。

import { QUIET_LABEL_AFTER_MS } from './quietThresholds';
import { t } from '@roost/i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 未观测到输出时间时返回 null；调用方据此显示「未知」而不是「刚刚」。 */
export function quietForLabel(elapsedMs: number | null): string | null {
  if (elapsedMs === null) return null;
  if (elapsedMs < QUIET_LABEL_AFTER_MS) return null;
  if (elapsedMs < MINUTE) return t.session.quiet.seconds(Math.floor(elapsedMs / 1000));
  if (elapsedMs < HOUR) return t.session.quiet.minutes(Math.floor(elapsedMs / MINUTE));
  const hours = Math.floor(elapsedMs / HOUR);
  const minutes = Math.floor((elapsedMs % HOUR) / MINUTE);
  return minutes ? t.session.quiet.hoursMinutes(hours, minutes) : t.session.quiet.hours(hours);
}
