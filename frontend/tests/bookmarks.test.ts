import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkResumeCommand, filterBookmarks, quoteArg } from '../src/features/bookmarks/model';
import { createBookmarkStore } from '../src/features/bookmarks/store';
import * as api from '../src/shared/api/bookmarks';
const card = (id: string, extra: Partial<api.Bookmark> = {}): api.Bookmark => ({ id, groupId: null, cliId: 'claude', nativeSessionId: 'session-one', cwd: '/my work', title: id, note: null, seq: 1, createdAt: 1, ...extra });
test('search and filters preserve manual order and match notes or directories', () => {
 const cards = [card('z', {note:'Later fix tests'}),card('a',{cliId:'omp',groupId:'g'}),card('b')];
 assert.deepEqual(filterBookmarks(cards,null,'','work later').map(c=>c.id),['z']);
 assert.deepEqual(filterBookmarks(cards,'g','omp','').map(c=>c.id),['a']);
 assert.deepEqual(filterBookmarks(cards,'','','').map(c=>c.id),['z','b']);
});
test('resume command quotes directory shell characters and refuses unsupported or invalid sessions', () => {
 assert.equal(quoteArg("a'b"),`'a'"'"'b'`);
 assert.equal(bookmarkResumeCommand(card('a')), "cd -- '/my work' && 'claude' '--resume' 'session-one'");
 assert.equal(bookmarkResumeCommand(card('a',{cliId:'not-supported'})),null);
 assert.equal(bookmarkResumeCommand(card('a',{nativeSessionId:'$(touch /tmp/no)'})),null);
 const command=bookmarkResumeCommand(card('a',{cwd:"/path/$(echo hi)/a'b"}));
 assert.ok(command?.startsWith(`cd -- '/path/$(echo hi)/a'"'"'b' && `));
});
test('a stale refresh cannot overwrite a completed bookmark mutation', async () => {
 let resolve!: (value: api.BookmarkBoard) => void;
 let reads=0;
 const board={cards:[card('saved')],groups:[]};
 const store=createBookmarkStore({...api,fetchBookmarks:()=>++reads===1?new Promise(r=>{resolve=r;}):Promise.resolve(board),addBookmark:async()=>card('saved')});
 const stale=store.refresh();await store.add(card('saved'));
 resolve({cards:[],groups:[]});await stale;
 assert.deepEqual(store.read().cards,board.cards);assert.equal(store.read().busy,false);
});
