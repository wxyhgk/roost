import { t } from '@roost/i18n';
import { ApiError } from '../../shared/api/errors';

/**
 * 再查也不会变的结论。
 *
 * 和 `resumePlanQuery.ts` 里的 `transient` 是互补的两半：那边决定「要不要自动重试」，
 * 这边决定「要不要给人一个『重新检查』按钮」。一句永远不会变的话旁边挂着可点的按钮，
 * 是在请人做一件注定没有结果的事。
 */
export const PERMANENT_RESUME_REASONS = new Set(['unsupported_cli', 'unusable_session_id']);

export function resumeReason(reason: string): string {
  const messages = t.terminal.recovery;
  switch (reason) {
    case 'identity_syncing': return messages.syncing;
    case 'identity_unconfirmed': return messages.unconfirmed;
    case 'source_unavailable': return messages.unavailable;
    case 'no_conversation': return messages.noConversation;
    case 'unsupported_cli': return messages.unsupported;
    case 'unusable_session_id': return messages.unusable;
    default: return messages.failed;
  }
}

export function resumeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'conflict') return t.terminal.recovery.alreadyRunning;
    if (['identity_syncing', 'identity_unconfirmed', 'source_unavailable', 'no_conversation', 'unsupported_cli', 'unusable_session_id'].includes(error.code ?? '')) {
      return resumeReason(error.code!);
    }
  }
  return error instanceof Error ? error.message : t.misc.terminal.restartFailed;
}
