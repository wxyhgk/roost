import { useEffect, useState } from 'react';
import { fetchTerminalConversation, listConversations } from '../../shared/api/conversations';
import { useSessionActivity } from '../session-status/useSessionActivity';
import { watchTerminalConversation } from './terminalIdentity';

export function useTerminalConversation(terminalId: string | null) {
  const { instanceId, cliId, agent } = useSessionActivity(terminalId ?? '');
  // An old agent's status can outlive its CLI; only pair a native ID with its own CLI.
  const nativeSessionId = agent?.name === cliId ? agent?.agentSessionId ?? null : null;
  const identityKey = JSON.stringify([terminalId, instanceId, cliId, nativeSessionId]);
  const [resolved, setResolved] = useState({ key: '', conversationId: null as string | null, current: false });
  useEffect(() => {
    if (!terminalId) return;
    return watchTerminalConversation({
      terminalId, identity: { instanceId, cliId, nativeSessionId },
      fetchCurrent: () => fetchTerminalConversation(terminalId),
      fetchHistory: async () => {
        const page = await listConversations({ terminalId, state: 'all', sort: 'activity' }, null, 30);
        return page.items.find(item => item.trashedAt === null)?.id ?? null;
      },
      changed: (conversationId, current) => setResolved(previous =>
        previous.key === identityKey && previous.conversationId === conversationId && previous.current === current
          ? previous : { key: identityKey, conversationId, current }),
    });
  }, [terminalId, instanceId, cliId, nativeSessionId, identityKey]);
  return resolved.key === identityKey ? resolved : { conversationId: null, current: false, key: identityKey };
}
