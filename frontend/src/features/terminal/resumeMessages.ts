import { t } from '@roost/i18n';
import { ApiError } from '../../shared/api/errors';

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
