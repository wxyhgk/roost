import { quietForLabel } from './quietFor';
import type { ActivityView } from './store';
import { t } from '@roost/i18n';

/**
 * 一个会话此刻的状态徽标。
 *
 * 会话行和画布卡片说的是同一件事，所以判定只有这一份。抄成两份迟早会一个说
 * 「AI 在等你」、另一个说「安静」——那时候用户信哪个？
 */
export type SessionBadge = {
  activityLabel: string;
  /** 活动点的配色类。 */
  dotTone: string;
  dotLabel: string;
  /** AI 在等你。与 PTY 活动正交（等待时 PTY 恰恰是安静的），所以单独一个角标。 */
  blocked: boolean;
  /** 「在等你批准」这一类，短到能放进角标。 */
  blockedKind: string;
  /** 同一句加上 agent 自己说的那件事，长到只适合放 tooltip。 */
  blockedLabel: string;
  /** 静默了多久；不到显示门槛返回 null。 */
  quietLabel: string | null;
  /** 静默中却没有观测记录（后端重启过）。标成未知，不要伪装成「刚刚」。 */
  quietUnknown: boolean;
};

export function sessionBadge(activity: ActivityView, quietFor: number | null): SessionBadge {
  const activityLabel = t.session.activity[activity.state];
  // 未读只进这唯一的点：把「安静」从暗灰升级成高亮，其余档位不变。
  // 脉动留给「正在输出」独占，否则两者区分不开。
  const dotTone =
    activity.state === 'active' ? 'bg-success motion-safe:animate-pulse'
    : activity.state === 'quiet' ? (activity.unread ? 'bg-accent' : 'bg-text-dim/50')
    : activity.state === 'exited' || activity.state === 'closed' ? 'bg-danger'
    : 'bg-warning';
  const blockedKind = activity.agent?.waitingFor === 'question'
    ? t.session.agent.needsAnswer
    : t.session.agent.needsPermission;
  // 角标本身只能表达「在等你」这一类；具体等的是哪件事只有 agent 说得清，
  // 有 summary 就接在后面——tooltip 和读屏拿到的是同一句，不做两套说法。
  const detail = activity.agent?.summary?.trim();
  return {
    activityLabel,
    dotTone,
    dotLabel: activity.unread && activity.state !== 'active' ? t.session.unread : activityLabel,
    blocked: activity.agent?.state === 'blocked',
    blockedKind,
    blockedLabel: detail ? t.session.agent.blockedWithDetail(blockedKind, detail) : blockedKind,
    quietLabel: quietForLabel(quietFor),
    quietUnknown: activity.state === 'quiet' && activity.lastOutputAt === null,
  };
}
