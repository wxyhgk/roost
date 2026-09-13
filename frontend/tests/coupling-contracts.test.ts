import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibraryQuery, type RecordChange } from '../src/features/library/query.ts';
import { registerTerminal, subscribeSelection, setTerminalInput, clearTerminalInput, sendToSession } from '../src/features/terminal/handles.ts';
import type { TermHandle } from '../src/features/terminal/types.ts';
import type { RecordData, Summary } from '../src/features/library/api.ts';
const row = (i: number): Summary => ({ id: String(i), title: `note ${i}`, summary: '', revision: 1, createdAt: 1, updatedAt: 1 });
const settle = () => new Promise(r => setImmediate(r));

test('saving a record preserves two loaded pages, cursor and unrelated resource query', async () => {
  const listeners = new Set<(event: RecordChange) => void>(); let requests = 0;
  const source = {
    list: async (_kind: string, _q: string, cursor?: string) => { requests++; return cursor ? { items: Array.from({length:10}, (_,i) => row(i+50)), nextCursor: null } : { items: Array.from({length:50}, (_,i) => row(i)), nextCursor: 'second' }; },
    subscribeRecords: (fn: (event: RecordChange) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    subscribeRefresh: () => () => {},
  };
  const notes = new LibraryQuery(source, 'notes', ''), snippets = new LibraryQuery(source, 'snippets', '');
  const stopNotes=notes.start(), stopSnippets=snippets.start(); await settle(); await notes.more();
  const before = requests;
  const record: RecordData = { ...row(55), deletedAt: null, text:'changed body', revision:2 };
  listeners.forEach(fn=>fn({kind:'notes', record}));
  assert.equal(requests,before); assert.equal(notes.snapshot().items.length,60); assert.equal(notes.snapshot().items[55].title,'changed body');
  assert.equal(notes.snapshot().nextCursor,null); assert.equal(snippets.snapshot().items[0].title,'note 0');
  listeners.forEach(fn=>fn({kind:'notes', record:{...record,deletedAt:5,revision:3}}));
  assert.equal(notes.snapshot().items.length,59); stopNotes(); stopSnippets();
});

test('mutation during an older list request is retained when the response arrives', async () => {
  let respond!: (page: {items: Summary[];nextCursor:null})=>void;
  let listener!: (event: RecordChange)=>void;
  const q=new LibraryQuery({ list:()=>new Promise(r=>{respond=r;}), subscribeRecords:fn=>{listener=fn;return()=>{};},subscribeRefresh:()=>()=>{} },'notes','');
  const stop=q.start();
  listener({kind:'notes',record:{...row(1),text:'new content',revision:2,deletedAt:null}});
  respond({items:[row(1)],nextCursor:null}); await settle();
  assert.equal(q.snapshot().items[0].title,'new content'); assert.equal(q.snapshot().items[0].revision,2); stop();
});

test('selection subscribers attach after mount and follow replacement without stale cleanup removing the new handle', () => {
  let calls=0, oldListener=()=>{}, newListener=()=>{}, oldDisposed=0, newDisposed=0;
  const off=subscribeSelection('test',()=>{calls++;});
  const old={onSelectionChange(fn:()=>void){oldListener=fn;return{dispose(){oldDisposed++;}};}} as TermHandle;
  const next={onSelectionChange(fn:()=>void){newListener=fn;return{dispose(){newDisposed++;}};}} as TermHandle;
  const removeOld=registerTerminal('test',old); oldListener();
  const removeNew=registerTerminal('test',next); assert.equal(oldDisposed,1);
  const count=calls; removeOld(); assert.equal(calls,count); newListener(); assert.equal(calls,count+1);
  off(); assert.equal(newDisposed,1); removeNew();
});

test('terminal public input result preserves rejected, queued and sent semantics', () => {
  assert.equal(sendToSession('none','x'),'rejected');
  for(const outcome of ['rejected','queued','sent'] as const){setTerminalInput('test',()=>outcome);assert.equal(sendToSession('test','x'),outcome);}
  clearTerminalInput('test'); assert.equal(sendToSession('test','x'),'rejected');
});
