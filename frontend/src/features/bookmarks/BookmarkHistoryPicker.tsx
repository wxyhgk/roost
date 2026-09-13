import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@roost/i18n';
import { listConversations, MAX_QUERY_LENGTH, type Conversation } from '../../shared/api/conversations';
import { ApiError } from '../../shared/api/errors';
import { groupByDay, timeLabel } from '../conversations/when';
import { BookmarkButton } from './BookmarkButton';

/** Browse saved history without changing the workspace's selected conversation or CLI. */
export function BookmarkHistoryPicker({ groupId, onRead }: {
  groupId: string | null;
  onRead: (conversation: Conversation) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const load = useCallback(async (after: string | null = null) => {
    const request = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const page = await listConversations({ q: query.trim(), state: 'all', sort: 'activity' }, after, 30);
      if (request !== sequence.current) return;
      const visible = page.items.filter(item => item.trashedAt === null);
      setItems(previous => after ? [...new Map([...previous, ...visible].map(item => [item.id, item])).values()] : visible);
      setCursor(page.nextCursor);
    } catch (error) {
      if (request !== sequence.current) return;
      if (error instanceof ApiError && error.code === 'list_changed') {
        setItems([]); setCursor(null); setReload(value => value + 1);
      } else setError(error instanceof Error ? error.message : String(error));
    } finally { if (request === sequence.current) setLoading(false); }
  }, [query]);
  useEffect(() => {
    setItems([]); setCursor(null); setLoading(true); setError(null);
    const timer = setTimeout(() => { void load(); }, query ? 250 : 0);
    return () => { sequence.current++; clearTimeout(timer); };
  }, [load, query, reload]);
  return <section aria-label={t.bookmarks.addFromHistory} className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b border-border px-5 py-3">
      <p className="mb-2 text-caption text-text-dim">{t.bookmarks.pickHint}</p>
      <input autoFocus type="search" aria-label={t.bookmarks.searchHistory} placeholder={t.bookmarks.searchHistory}
        value={query} maxLength={MAX_QUERY_LENGTH} onChange={event => setQuery(event.target.value)}
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text outline-none focus:border-accent" />
    </div>
    <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
      {error && <div role="alert" className="mb-3 flex items-center gap-2 text-caption text-danger"><span>{error}</span>
        <button className="rounded border border-border px-2 py-1 text-text" onClick={() => void load(cursor)}>{t.bookmarks.retry}</button></div>}
      {!loading && !error && !items.length && <p role="status" className="py-10 text-center text-caption text-text-dim">{query.trim() ? t.bookmarks.noHistoryMatch : t.bookmarks.noSavedHistory}</p>}
      {groupByDay(items, item => item.lastMessageAt ?? item.createdAt).map(day => <div key={day.key} className="mb-4">
        <h3 className="mb-2 text-caption font-medium text-text-dim">{day.label}</h3>
        <div className="space-y-2">{day.items.map(item => <article key={item.id} aria-label={`${item.source.cliId} · ${item.title} · ${item.source.nativeSessionId}`}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
          <button type="button" onClick={() => onRead(item)} title={t.bookmarks.view} className="min-w-0 flex-1 text-left hover:text-accent">
            <div className="flex items-center gap-2"><span className="truncate text-body font-medium">{item.title}</span>
              <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-caption text-text-dim">{item.source.cliId}</span>
              <time className="ml-auto shrink-0 text-caption text-text-dim" dateTime={new Date(item.lastMessageAt ?? item.createdAt).toISOString()}>{timeLabel(item.lastMessageAt ?? item.createdAt)}</time></div>
            <p className="mt-1 truncate text-caption text-text-dim" title={item.source.cwd ?? ''}>{item.source.cwd ?? item.source.nativeSessionId}</p>
            <p className="mt-1 truncate font-mono text-caption text-text-dim/70">{item.source.nativeSessionId}</p>
          </button>
          <BookmarkButton conversation={item} groupId={groupId} />
        </article>)}</div>
      </div>)}
      {loading && <p role="status" className="py-4 text-center text-caption text-text-dim">{t.bookmarks.loading}</p>}
      {cursor && !error && <button disabled={loading} onClick={() => void load(cursor)} className="w-full rounded-md border border-border px-3 py-2 text-caption hover:bg-bg-hover disabled:opacity-50">{t.bookmarks.more}</button>}
    </div>
  </section>;
}
