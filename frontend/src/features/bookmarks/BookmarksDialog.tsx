import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon, BookmarkIcon } from '@heroicons/react/24/outline';
import { t } from '@roost/i18n';
import { uid } from "../../shared/uid";
import { writeClipboard } from '../../shared/clipboard';
import { fetchBookmarkConversation, type Bookmark, type BookmarkGroup } from '../../shared/api/bookmarks';
import type { Conversation } from '../../shared/api/conversations';
import { ConversationDetail } from '../conversations/ConversationDetail';
import { bookmarks, useBookmarks } from './useBookmarks';
import { BookmarkHistoryPicker } from './BookmarkHistoryPicker';
import { bookmarkResumeCommand, filterBookmarks } from './model';

const button = 'rounded-md border border-border px-2.5 py-1.5 text-caption text-text hover:bg-bg-hover disabled:opacity-40';
const field = 'w-full rounded-md border border-border bg-bg px-2.5 py-2 text-body text-text outline-none focus:border-accent';
const perform = (promise: Promise<unknown>) => { void promise.catch(() => {}); };

export function BookmarksDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const state = useBookmarks();
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cli, setCli] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [picking, setPicking] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { request.current++; element.close(); previous?.focus(); };
  }, []);
  const cards = filterBookmarks(state.cards, group, cli, query);
  const card = cards.find(item => item.id === selected);
  const emptyBoard = state.loaded && state.cards.length === 0 && !picking && !conversation;
  const activeGroup = state.groups.find(item => item.id === group);
  const choose = (id: string | null) => { request.current++; setSelected(id); setNotice(null); setReading(false); setConversation(null); };
  const pickHistory = () => { choose(null); setPicking(true); };
  async function read(card: Bookmark) {
    const version = ++request.current;
    setReading(true); setNotice(null);
    try {
      const found = await fetchBookmarkConversation(card.id);
      if (version !== request.current) return;
      if (found) setConversation(found); else setNotice(t.bookmarks.noHistory);
    } catch (error) { if (version === request.current) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (version === request.current) setReading(false); }
  }
  return createPortal(<dialog ref={dialog} aria-labelledby="bookmarks-title" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className={`m-auto max-h-[95dvh] max-w-none overflow-hidden rounded-xl border border-border bg-bg p-0 text-text shadow-2xl backdrop:bg-black/45 ${emptyBoard ? "h-[min(65vh,520px)] w-[min(850px,96vw)]" : "h-[min(82vh,850px)] w-[min(1100px,96vw)]"}`}>
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <BookmarkIcon className="size-6 text-accent" /><div className="min-w-0 flex-1"><h2 id="bookmarks-title" className="text-title font-semibold">{t.bookmarks.title}</h2><p className="text-caption text-text-dim">{t.bookmarks.subtitle}</p></div>
        <button className={button} onClick={() => { if (picking) { setPicking(false); setConversation(null); } else pickHistory(); }}>{picking ? t.bookmarks.back : t.bookmarks.addFromHistory}</button>
        <button className={button} disabled={state.loading || state.busy} onClick={() => void bookmarks.refresh()}>{t.bookmarks.refresh}</button>
        <button aria-label={t.bookmarks.close} className="rounded-md p-1.5 hover:bg-bg-hover" onClick={onClose}><XMarkIcon className="size-5" /></button>
      </header>
      {state.error && <div role="alert" className="flex items-center gap-2 border-b border-border px-5 py-2 text-caption text-danger"><span className="min-w-0 flex-1 break-words">{state.error}</span><button className={button} onClick={() => void bookmarks.refresh()}>{t.bookmarks.retry}</button></div>}
      {picking && <div className={conversation ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}><BookmarkHistoryPicker groupId={activeGroup?.id ?? null} onRead={setConversation} /></div>}
      {conversation ? <div className="flex min-h-0 flex-1 flex-col"><ConversationDetail key={conversation.id} conversation={conversation} readOnly onBack={() => setConversation(null)} /></div> : !picking ? <>
        <div className="flex shrink-0 gap-2 border-b border-border px-5 py-3">
          <input autoFocus type="search" aria-label={t.bookmarks.search} placeholder={t.bookmarks.search} value={query} onChange={event => { setQuery(event.target.value); choose(null); }} className={field} />
          <select aria-label={t.bookmarks.allCli} value={cli} onChange={event => { setCli(event.target.value); choose(null); }} className={`${field} max-w-36`}><option value="">{t.bookmarks.allCli}</option>{[...new Set(state.cards.map(item => item.cliId))].sort().map(id => <option key={id}>{id}</option>)}</select>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="flex shrink-0 flex-col gap-1 overflow-auto border-b border-border p-3 sm:w-44 sm:border-r sm:border-b-0">
            {[{ id: null, name: t.bookmarks.all }, { id: '', name: t.bookmarks.ungrouped }, ...state.groups].map(item => <button key={item.id ?? 'all'} aria-pressed={group === item.id} onClick={() => { setGroup(item.id); choose(null); setEditingGroup(null); }} className={`flex items-center gap-2 rounded-md px-2 py-2 text-left text-caption ${group === item.id ? 'bg-accent/10 text-accent' : 'hover:bg-bg-hover'}`}><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="text-text-dim">{state.cards.filter(card => item.id === null || (card.groupId ?? '') === item.id).length}</span></button>)}
            <button className={`${button} mt-2`} disabled={state.busy} onClick={() => { setEditingGroup(''); setGroupName(''); }}>{t.bookmarks.newGroup}</button>
            {activeGroup && <div className="flex flex-wrap gap-1"><button className={button} disabled={state.busy} onClick={() => { setEditingGroup(activeGroup.id); setGroupName(activeGroup.name); }}>{t.bookmarks.renameGroup}</button><button className={button} disabled={state.busy} onClick={() => { perform(bookmarks.removeGroup(activeGroup.id).then(() => { setGroup(''); setEditingGroup(null); })); }} title={t.bookmarks.deleteGroupHint}>{t.bookmarks.deleteGroup}</button></div>}
            {editingGroup !== null && <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); const name = groupName.trim(); if (!name) return; perform((editingGroup ? bookmarks.updateGroup(editingGroup, { name }) : bookmarks.addGroup(uid(), name)).then(() => setEditingGroup(null))); }}><input aria-label={t.bookmarks.groupName} value={groupName} maxLength={4096} onChange={event => setGroupName(event.target.value)} className={field} /><button className={button} disabled={state.busy || !groupName.trim()}>{t.bookmarks.save}</button><button type="button" className={button} onClick={() => setEditingGroup(null)}>{t.bookmarks.cancel}</button></form>}
          </aside>
          <section aria-label={t.bookmarks.all} className="min-h-0 flex-1 overflow-auto p-3">
            {!state.loaded ? <p className="p-4 text-caption text-text-dim">{state.loading ? t.bookmarks.loading : t.bookmarks.historyFailed}</p> : !cards.length ? <div className="flex min-h-64 h-full flex-col items-center justify-center p-6 text-center text-text-dim"><BookmarkIcon className="mx-auto mb-3 size-8 opacity-50" /><p>{state.cards.length ? t.bookmarks.noMatch : t.bookmarks.empty}</p>{!state.cards.length && <div className="mt-2 max-w-md space-y-4"><p className="text-caption">{t.bookmarks.emptyHint}</p><button className={button} onClick={pickHistory}>{t.bookmarks.addFromHistory}</button></div>}</div> : <div className="space-y-2">{cards.map(item => <button key={item.id} onClick={() => choose(item.id)} aria-pressed={selected === item.id} className={`block w-full rounded-lg border p-3 text-left ${selected === item.id ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-hover'}`}><div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words text-body font-medium">{item.title}</span><span className="rounded bg-bg-hover px-1.5 py-0.5 text-caption text-text-dim">{item.cliId}</span></div>{item.note && <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-caption text-text-dim">{item.note}</p>}<p className="mt-2 truncate text-caption text-text-dim" title={item.cwd ?? ''}>{item.cwd ?? item.nativeSessionId}</p></button>)}</div>}
          </section>
          {(card || notice) && <aside className="max-h-[45%] shrink-0 overflow-auto border-t border-border p-4 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l">
            {card ? <BookmarkEditor key={card.id} card={card} groups={state.groups} siblings={state.cards.filter(item => item.groupId === card.groupId)} busy={state.busy} onRead={() => void read(card)} reading={reading} onRemoved={() => choose(null)} /> : <p className="py-8 text-center text-caption text-text-dim">{t.bookmarks.choose}</p>}
            {notice && <p role="status" className="mt-3 text-caption text-text-dim">{notice}</p>}
          </aside>}
        </div>
      </> : null}
    </div>
  </dialog>, document.body);
}

function BookmarkEditor({ card, groups, siblings, busy, onRead, reading, onRemoved }: { card: Bookmark; groups: BookmarkGroup[]; siblings: Bookmark[]; busy: boolean; onRead: () => void; reading: boolean; onRemoved: () => void }) {
  const [title, setTitle] = useState(card.title), [note, setNote] = useState(card.note ?? ''), [group, setGroup] = useState(card.groupId ?? '');
  const [copyStatus, setCopyStatus] = useState('');
  const command = bookmarkResumeCommand(card);
  const position = siblings.findIndex(item => item.id === card.id);
  return <div className="space-y-4">
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); perform(bookmarks.update(card.id, { title: title.trim(), note: note || null, groupId: groups.some(item => item.id === group) ? group : null })); }}>
      <label className="block space-y-1 text-caption text-text-dim"><span>{t.bookmarks.rename}</span><input value={title} onChange={event => setTitle(event.target.value)} maxLength={4096} className={field} /></label>
      <label className="block space-y-1 text-caption text-text-dim"><span>{t.bookmarks.note}</span><textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={4096} placeholder={t.bookmarks.noteHint} className={`${field} resize-y`} /></label>
      <label className="block space-y-1 text-caption text-text-dim"><span>{t.bookmarks.group}</span><select value={groups.some(item => item.id === group) ? group : ''} onChange={event => setGroup(event.target.value)} className={field}><option value="">{t.bookmarks.ungrouped}</option>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button className={button} disabled={busy || !title.trim()}>{busy ? t.bookmarks.saving : t.bookmarks.save}</button>
    </form>
    <dl className="space-y-2 text-caption"><div><dt className="text-text-dim">{t.bookmarks.nativeId}</dt><dd className="select-text break-all font-mono">{card.nativeSessionId}</dd></div>{card.cwd && <div><dt className="text-text-dim">{t.bookmarks.directory}</dt><dd className="select-text break-all">{card.cwd}</dd></div>}</dl>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={reading} onClick={onRead}>{reading ? t.bookmarks.loading : t.bookmarks.view}</button><button className={button} disabled={!command} title={command ?? t.bookmarks.noResume} onClick={() => { if (command) void writeClipboard(command).then(copied => setCopyStatus(copied ? t.bookmarks.copied : t.bookmarks.copyFailed)); }}>{t.bookmarks.copyResume}</button></div>
    {copyStatus && <p role="status" className="text-caption text-text-dim">{copyStatus}</p>}
    <p className="text-caption text-text-dim">{t.bookmarks.recordHint}</p>
    <div className="flex flex-wrap gap-2 border-t border-border pt-3"><button className={button} disabled={busy || position <= 0} onClick={() => perform(bookmarks.update(card.id, { beforeId: siblings[position - 1]!.id }))}>{t.bookmarks.moveUp}</button><button className={button} disabled={busy || position >= siblings.length - 1} onClick={() => perform(bookmarks.update(card.id, { beforeId: siblings[position + 2]?.id ?? null }))}>{t.bookmarks.moveDown}</button><button className={button} disabled={busy} title={t.bookmarks.removeHint} onClick={() => perform(bookmarks.remove(card.id).then(onRemoved))}>{t.bookmarks.remove}</button></div>
  </div>;
}
