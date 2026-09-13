import { BookmarkIcon } from '@heroicons/react/24/outline';
import type { Conversation } from '../../shared/api/conversations';
import { t } from '@roost/i18n';
import { bookmarks, useBookmarks } from './useBookmarks';
import { uid } from '../library/api';

export function BookmarkButton({ conversation, groupId = null }: { conversation: Conversation; groupId?: string | null }) {
  const state = useBookmarks();
  const saved = state.cards.some(card => card.cliId === conversation.source.cliId && card.nativeSessionId === conversation.source.nativeSessionId);
  return <span className="flex shrink-0 flex-col items-end">
    <button type="button" disabled={saved || state.busy || !state.loaded} aria-label={saved ? t.bookmarks.saved : t.bookmarks.add}
      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption text-text hover:bg-bg-hover disabled:opacity-60"
      onClick={() => { void bookmarks.add({ id: uid(), cliId: conversation.source.cliId, nativeSessionId: conversation.source.nativeSessionId,
        cwd: conversation.source.cwd, title: conversation.title, groupId }).catch(() => {}); }}>
      <BookmarkIcon className={`size-3.5 ${saved ? 'fill-current' : ''}`} />{saved ? t.bookmarks.saved : t.bookmarks.add}
    </button>
    {state.error && <button type="button" onClick={() => void bookmarks.refresh()} className="max-w-48 truncate text-caption text-danger" title={state.error}>{t.bookmarks.retry}</button>}
  </span>;
}
