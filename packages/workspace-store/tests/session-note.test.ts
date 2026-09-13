import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspaceStore } from '../src/index.ts';

test('upgrades an actual six-column sessions table in place and remains compatible with older named-column writers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'session-note-old-'));
  const old = new DatabaseSync(join(dir, 'workspace.sqlite'));
  old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT,cwd TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,seq INTEGER NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO projects VALUES('p','Project','#fff',1);
    INSERT INTO sessions VALUES('first','Original','p','/tmp',0,1),('closed','Closed',NULL,'/tmp',1,2);
    INSERT INTO meta VALUES('sessionSeq','2'),('selectedId','first');`);
  const oldUpdate = old.prepare('UPDATE sessions SET title=?,cwd=?,closed=? WHERE id=?');
  const beforeRows = old.prepare('SELECT rowid,* FROM sessions ORDER BY seq').all();
  let store = createWorkspaceStore({ dataDir: dir });
  t.after(() => { store.close(); old.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(store.loadWorkspace().sessions.map(row => row.note), [null, null]);
  assert.deepEqual(old.prepare('SELECT rowid,id,title,project_id,cwd,closed,seq FROM sessions ORDER BY seq').all(), beforeRows);
  assert.equal(store.loadWorkspace().selectedId, 'first');
  store.setSessionNote('first', '  维护前端\n等待测试  ');
  oldUpdate.run('Renamed', '/tmp/new', 1, 'first');
  store.close(); store = createWorkspaceStore({ dataDir: dir });
  assert.equal(store.getSessionRecord('first')!.note, '维护前端\n等待测试');
  assert.equal(store.getSessionRecord('first')!.title, 'Renamed');
  assert.equal((old.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).filter(row => row.name === 'note').length, 1);
  assert.equal(old.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('notes normalize clearing, reject oversized or invalid writes and follow only the terminal record lifecycle', t => {
  const dir = mkdtempSync(join(tmpdir(), 'session-note-store-'));
  const store = createWorkspaceStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.upsertSession({ id: 's', cwd: dir }).note, null);
  for (const cleared of ['', ' \n\t\u3000 ', null]) {
    store.setSessionNote('s', 'before'); store.setSessionNote('s', cleared);
    assert.equal(store.getSessionRecord('s')!.note, null);
  }
  store.setSessionNote('s', '中'.repeat(2000));
  for (const value of ['x'.repeat(2001), ' '.repeat(2001), false, 5, {}, []]) {
    assert.throws(() => store.setSessionNote('s', value as string));
    assert.equal(store.getSessionRecord('s')!.note, '中'.repeat(2000));
  }
  store.setSessionClosed('s', true);
  assert.equal(store.upsertSession({ id: 's', title: 'Updated', cwd: '/tmp', closed: false }).note, '中'.repeat(2000));
  store.deleteSessionRecord('s');
  assert.equal(store.upsertSession({ id: 's', cwd: dir }).note, null);
});
