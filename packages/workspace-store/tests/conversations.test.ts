import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAiSessionBridge } from '@roost/ai-session-bridge';
import { createWorkspaceStore } from '../src/index.ts';

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-g1-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// Frozen pre-catalog storageFormat 2 schema. Do not build an "old" fixture by
// opening today's store: that would silently skip the actual migration path.
function legacyFixture(dir: string) {
  const db = new DatabaseSync(join(dir, 'workspace.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT,cwd TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL);
    CREATE TABLE ai_session_records(session_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
    CREATE UNIQUE INDEX ai_session_native_identity ON ai_session_records(json_extract(record_json,'$.binding.cliId'),json_extract(record_json,'$.binding.nativeSessionId'));
    CREATE TABLE ai_conversations(id TEXT PRIMARY KEY,cli_id TEXT NOT NULL,native_id TEXT NOT NULL,last_seq INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 1,UNIQUE(cli_id,native_id));
    CREATE TABLE ai_generations(session_id TEXT NOT NULL,generation TEXT NOT NULL,conversation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,binding_json TEXT NOT NULL,opened_at INTEGER NOT NULL,closed_at INTEGER,upper_bound INTEGER NOT NULL DEFAULT 0,coverage_json TEXT NOT NULL,PRIMARY KEY(session_id,generation),UNIQUE(session_id,ordinal));
    CREATE TABLE ai_history_messages(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,preview_json TEXT NOT NULL,body_state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,event_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(conversation_id,message_id),UNIQUE(conversation_id,seq));
    CREATE TABLE ai_history_bodies(conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(conversation_id,message_id));
    CREATE TABLE ai_session_replay(session_id TEXT NOT NULL,generation TEXT NOT NULL,seq INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(session_id,generation,seq));
    CREATE TABLE ai_history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE ai_history_legacy_records(session_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
    CREATE TABLE ai_commands(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(session_id,request_id));
    INSERT INTO ai_history_meta VALUES('schema.v1','1');
    CREATE TRIGGER ai_history_writer_insert BEFORE INSERT ON ai_session_records WHEN COALESCE(json_extract(NEW.record_json,'$.storageFormat'),0)<>2 BEGIN SELECT RAISE(ABORT,'old format gate'); END;
    CREATE TRIGGER ai_history_writer_update BEFORE UPDATE ON ai_session_records WHEN COALESCE(json_extract(NEW.record_json,'$.storageFormat'),0)<>2 BEGIN SELECT RAISE(ABORT,'old format gate'); END;
  `);
  const cid = createHash('sha256').update(JSON.stringify(['local', 'omp', 'legacy-native'])).digest('hex');
  const binding = {webSessionId:'legacy-terminal',terminalInstanceId:'old-instance',generation:'old-generation',revision:1,cliId:'omp',nativeSessionId:'legacy-native',state:'ready',updatedAt:100};
  const events = [
    {eventId:'original',type:'message',role:'user',content:'literal 100%_ needle'},
    {eventId:'original',type:'message',role:'user',content:'revised preserved body'},
    {eventId:'partial',type:'message',role:'assistant',content:'preview only',data:{truncated:true,detail:{path:'/missing/synthetic.jsonl',hash:'fixture'}}},
  ];
  const mids = ['original','original~r2~fixture','partial'];
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('legacy-terminal','Legacy title',null,dir,0,1);
  db.prepare('INSERT INTO ai_conversations VALUES(?,?,?,?,?)').run(cid,'omp','legacy-native',3,2);
  db.prepare('INSERT INTO ai_session_records VALUES(?,?)').run('legacy-terminal',JSON.stringify({binding,cursor:3,droppedThrough:2,hasSeenMessages:true,storageFormat:2}));
  db.prepare('INSERT INTO ai_commands(session_id,request_id,digest,record_json) VALUES(?,?,?,?)').run('legacy-terminal','accepted-request','fixture',JSON.stringify({webSessionId:'legacy-terminal',requestId:'accepted-request',status:'accepted',nativeSessionId:'legacy-native',nativeMessageId:'native-receipt',text:'old accepted command',revision:1}));
  db.prepare('INSERT INTO ai_generations VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-terminal',binding.generation,cid,1,JSON.stringify(binding),100,null,0,JSON.stringify({hasGap:true,skippedRecords:2}));
  for (let i=0;i<events.length;i++) {
    db.prepare('INSERT INTO ai_history_messages VALUES(?,?,?,?,?,?,?,?)').run(cid,mids[i],i+1,JSON.stringify(events[i]),i===2?'source_backed':'stored',i===1?2:1,events[i].eventId,'fixture-'+i);
    db.prepare('INSERT INTO ai_history_bodies VALUES(?,?,?)').run(cid,mids[i],JSON.stringify(events[i]));
  }
  return {db,cid,binding,events,mids};
}

function fixture(t:TestContext) {
  const dir=directory(t),store=createWorkspaceStore({dataDir:dir});
  t.after(()=>store.close());
  const bridge=createAiSessionBridge({storage:store.aiSessions});
  function bind(native:string,terminal='web-'+native) {
    store.upsertSession({id:terminal,cwd:dir});
    return bridge.bind({webSessionId:terminal,terminalInstanceId:'instance-'+terminal,cliId:'omp',nativeSessionId:native});
  }
  return {dir,store,bridge,bind};
}

test('format 2 fixture migrates once retaining old IDs, revisions, coverage and immutable body bytes',t=>{
  const dir=directory(t),old=legacyFixture(dir);t.after(()=>old.db.close());
  let store=createWorkspaceStore({dataDir:dir});
  try {
    const record=store.conversations.list({state:'all'}).items[0]!;
    assert.match(record.id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(record.source.legacyConversationId,old.cid);
    assert.equal(record.source.originScope,'legacy-local');
    assert.equal(record.source.locatorStatus,'unverified');
    const page=store.conversations.pageMessages(record.id);
    assert.equal(page.conversationId,record.id);
    assert.equal(page.coverage.hasGap,true);
    assert.deepEqual(page.items.map(x=>x.messageId),old.mids);
    assert.deepEqual(page.items.map(x=>x.sourceRevision),[1,2,1]);
    for(let i=0;i<old.mids.length;i++)assert.deepEqual(store.conversations.getMessage(record.id,old.mids[i]!).event,old.events[i]);
    assert.equal(page.items[2]!.bodyState,'source_backed');
    const persisted=JSON.parse(String(old.db.prepare('SELECT record_json FROM ai_session_records').get()!.record_json));
    assert.equal(persisted.storageFormat,3);
    store.close();store=createWorkspaceStore({dataDir:dir});
    assert.deepEqual(store.conversations.list({state:'all'}).items.map(x=>x.id),[record.id]);
    assert.equal(store.aiSessions.history!.getMessage('legacy-terminal','old-generation','original').event.content,old.events[0]!.content);
    assert.equal(old.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    assert.deepEqual(old.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {store.close();}
});

test('connection held across migration cannot perform old writer updates or last-terminal history deletion',t=>{
  const dir=directory(t),old=legacyFixture(dir);t.after(()=>old.db.close());
  const oldUpdate=old.db.prepare('UPDATE ai_session_records SET record_json=? WHERE session_id=?');
  const oldBodyDelete=old.db.prepare('DELETE FROM ai_history_bodies WHERE conversation_id=?');
  const store=createWorkspaceStore({dataDir:dir});t.after(()=>store.close());
  const id=store.conversations.list().items[0]!.id;
  assert.throws(()=>oldUpdate.run(JSON.stringify({binding:old.binding,storageFormat:2,cursor:0}),'legacy-terminal'));
  assert.throws(()=>oldBodyDelete.run(old.cid));
  for(const table of ['ai_conversations','ai_generations','ai_history_messages','ai_session_records','ai_commands']) {
    assert.throws(()=>old.db.exec(`DELETE FROM ${table}`),table+' must reject obsolete writer');
  }
  assert.equal(store.conversations.getMessage(id,'original').event.content,old.events[0]!.content);
  assert.equal(store.aiSessions.list().length,1);
  // Even a current connection capability cannot write an obsolete record format.
  old.db.function('diy_conversation_writer_v1',()=>1);
  assert.throws(()=>oldUpdate.run(JSON.stringify({binding:old.binding,storageFormat:2,cursor:0}),'legacy-terminal'),/upgraded gateway/);
});

test('failed format upgrade rolls back catalog and marker so the original legacy connection can retry migration',t=>{
  const dir=directory(t),old=legacyFixture(dir);t.after(()=>old.db.close());
  old.db.exec("CREATE TRIGGER fail_format_upgrade BEFORE UPDATE ON ai_session_records WHEN json_extract(NEW.record_json,'$.storageFormat')=3 BEGIN SELECT RAISE(ABORT,'migration failure injected'); END");
  assert.throws(()=>createWorkspaceStore({dataDir:dir}),/migration failure injected/);
  assert.equal(JSON.parse(String(old.db.prepare('SELECT record_json FROM ai_session_records').get()!.record_json)).storageFormat,2);
  assert.equal(old.db.prepare("SELECT COUNT(*) AS n FROM ai_history_meta WHERE key='schema.conversations.v1'").get()!.n,0);
  assert.equal(old.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='conversation_catalog'").get()!.n,0,'failed migration leaves no partially committed directory');
  const raw=old.db.prepare('SELECT event_json FROM ai_history_bodies WHERE message_id=?').get('original');
  assert.deepEqual(JSON.parse(String(raw!.event_json)),old.events[0]);
  old.db.exec('DROP TRIGGER fail_format_upgrade');
  const store=createWorkspaceStore({dataDir:dir});
  try {
    assert.equal(store.conversations.list().items.length,1);
    assert.equal(store.conversations.pageMessages(store.conversations.list().items[0]!.id).items.length,3);
  }finally{store.close();}
});

test('deleting final terminal preserves standalone history and reconnecting native source reuses UUID',t=>{
  const f=fixture(t),first=f.bind('native','first');
  f.bridge.publish('first',{type:'message',eventId:'body',content:'survives terminal removal'});
  const record=f.store.conversations.list().items[0]!;
  f.store.deleteSessionRecord('first');
  assert.equal(f.store.getSessionRecord('first'),null);
  assert.equal(f.store.conversations.getMessage(record.id,'body').event.content,'survives terminal removal');
  assert.equal(f.store.aiSessions.history!.pageMessages('first',first.generation).items.length,1);
  const fresh=createAiSessionBridge({storage:f.store.aiSessions});
  f.store.upsertSession({id:'second',cwd:f.dir});
  fresh.bind({webSessionId:'second',terminalInstanceId:'new-instance',cliId:'omp',nativeSessionId:'native'});
  assert.deepEqual(f.store.conversations.list({state:'all'}).items.map(x=>x.id),[record.id]);
  fresh.publish('second',{type:'message',eventId:'new',content:'after reconnect'});
  assert.deepEqual(f.store.conversations.pageMessages(record.id).items.map(x=>x.event.content),['survives terminal removal','after reconnect']);
});

test('metadata revision is checked across connections and user titles survive new messages',t=>{
  const f=fixture(t);f.bind('metadata');
  const initial=f.store.conversations.list().items[0]!;
  const other=createWorkspaceStore({dataDir:f.dir});t.after(()=>other.close());
  const renamed=f.store.conversations.patch(initial.id,{revision:initial.revision,title:'Chosen title'});
  assert.equal(renamed.titleOrigin,'user');
  assert.equal(renamed.revision,initial.revision+1);
  assert.throws(()=>other.conversations.patch(initial.id,{revision:initial.revision,title:'Lost update'}),(err:any)=>err.status===409&&err.code==='conflict');
  f.bridge.publish('web-metadata',{type:'message',eventId:'later',content:'A different title candidate'});
  assert.equal(other.conversations.get(initial.id).title,'Chosen title');
  const archived=other.conversations.patch(initial.id,{revision:other.conversations.get(initial.id).revision,archived:true});
  assert.equal(f.store.conversations.list().items.length,0);
  assert.equal(f.store.conversations.list({state:'archived'}).items[0]!.id,initial.id);
  assert.equal(f.store.conversations.getMessage(initial.id,'later').event.content,'A different title candidate');
  other.conversations.patch(initial.id,{revision:archived.revision,archived:false});
  assert.equal(f.store.conversations.list().items.length,1);
});

test('literal search does not interpret percent or underscore as wildcard and pagination never merges rows',t=>{
  const f=fixture(t);
  for(const [native,title] of [['one','100%_ literal'],['two','100AA wildcard'],['three','plain']]) {
    f.bind(native!);const r=f.store.conversations.list({state:'all'}).items.find(x=>x.source.nativeSessionId===native)!;
    f.store.conversations.patch(r.id,{revision:r.revision,title:title!});
  }
  assert.deepEqual(f.store.conversations.list({q:'%_'}).items.map(x=>x.title),['100%_ literal']);
  f.bridge.publish('web-three',{type:'message',eventId:'search-body',content:'body-only needle [literal]'});
  assert.equal(f.store.conversations.list({q:'body-only needle'}).items[0]!.source.nativeSessionId,'three');
  const ids:string[]=[];let cursor:string|undefined;
  do {const page=f.store.conversations.list({limit:1,cursor});ids.push(...page.items.map(x=>x.id));cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
  assert.throws(()=>f.store.conversations.list({cursor:'not-a-cursor'}));
  assert.throws(()=>f.store.conversations.list({limit:0}));
});

test('message preview stays bounded while explicit detail retains full saved body after terminal deletion',t=>{
  const f=fixture(t);f.bind('large');
  const content='中文'.repeat(100000)+'TAIL_NEEDLE_FULL_BODY_ONLY';
  f.bridge.publish('web-large',{type:'message',eventId:'large/body',content});
  const id=f.store.conversations.list().items[0]!.id;
  f.store.deleteSessionRecord('web-large');
  assert.ok(Buffer.byteLength(JSON.stringify(f.store.conversations.list()))<32*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(f.store.conversations.pageMessages(id,{limit:1})))<160*1024);
  assert.equal(f.store.conversations.getMessage(id,'large/body').event.content,content);
  assert.deepEqual(f.store.conversations.list({q:'TAIL_NEEDLE_FULL_BODY_ONLY'}).items.map(x=>x.id),[id],'search includes saved body past preview truncation');
});

test('deleting a project ungroups conversations without deleting content or replacing their stable IDs',t=>{
  const f=fixture(t);f.bind('project');
  f.bridge.publish('web-project',{type:'message',eventId:'kept',content:'project-independent'});
  const p=f.store.createProject({name:'Temporary',color:'#123456'});
  const initial=f.store.conversations.list().items[0]!;
  f.store.conversations.patch(initial.id,{revision:initial.revision,projectId:p.id});
  assert.equal(f.store.conversations.list({projectId:p.id}).items.length,1);
  f.store.deleteProjectRecord(p.id);
  assert.equal(f.store.conversations.get(initial.id).projectId,null);
  assert.equal(f.store.conversations.getMessage(initial.id,'kept').event.content,'project-independent');
});

test('backup includes committed WAL data, leaves legacy schema unmigrated and never overwrites destination',async t=>{
  const dir=directory(t),old=legacyFixture(dir);t.after(()=>old.db.close());
  old.db.exec('PRAGMA wal_autocheckpoint=0');
  old.db.prepare('UPDATE sessions SET title=?').run('committed in WAL');
  const moduleUrl=new URL('../../../scripts/conversation-database-backup.mjs',import.meta.url).href;
  const {backupConversationDatabase}=await import(moduleUrl);
  const destination=join(dir,'backup.sqlite');
  await backupConversationDatabase(dir,destination);
  const backup=new DatabaseSync(destination,{readOnly:true});
  try {
    assert.equal(backup.prepare('SELECT title FROM sessions').get()!.title,'committed in WAL');
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='conversation_catalog'").get()!.n,0);
    assert.equal(old.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='conversation_catalog'").get()!.n,0);
    assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  }finally{backup.close();}
  const bytes=readFileSync(destination);
  old.db.prepare('UPDATE sessions SET title=?').run('newer source state');
  await assert.rejects(()=>backupConversationDatabase(dir,destination));
  assert.deepEqual(readFileSync(destination),bytes);
  assert.equal(readdirSync(dir).filter(name=>name.includes('.partial-')).length,0);
});

/*
  对话的名字和归属：从对话自己推，不从建它那一刻的终端拍快照。

  原来是快照：建对话那一刻取终端的 title 和 project_id，而 project_id 此后再也不更新。
  实测这台机器 21 条对话里 14 条标题是 `omp 3749983a-1594-47` 这种、10 条永远没有归属，
  因为三分之二的对话被观测到时根本没有一个可用的终端。

  （「人起的名字不被新消息冲掉」那一条在上面的 metadata 用例里已经覆盖，这里不重复。）
*/
test('标题从第一条用户消息推出来，而不是留一个 `omp <id前缀>`', t => {
  const f = fixture(t); f.bind('derived-title');
  f.bridge.publish('web-derived-title', {type: 'message', eventId: 'e1', role: 'user', content: '帮我把端口面板重排一下'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'derived-title')!;
  assert.equal(record.title, '帮我把端口面板重排一下');
  assert.equal(record.titleOrigin, 'derived');
});

test('助手的回答不会被当成标题——标题要取第一条**用户**消息', t => {
  // 取错角色的后果是整个目录的标题都变成 AI 的开场白，彼此长得一模一样。
  const f = fixture(t); f.bind('assistant-first');
  f.bridge.publish('web-assistant-first', {type: 'message', eventId: 'a1', role: 'assistant', content: '好的，我来看一下'});
  f.bridge.publish('web-assistant-first', {type: 'message', eventId: 'u1', role: 'user', content: '这是我的问题'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'assistant-first')!;
  assert.equal(record.title, '这是我的问题');
});

test('归属按运行记录重算，不是创建时从终端抄一次', t => {
  const f = fixture(t);
  const project = f.store.createProject({id: 'p1', name: '分组一', color: '#fff'});
  f.bind('derived-project');
  f.bridge.publish('web-derived-project', {type: 'message', eventId: 'e1', role: 'user', content: '一句话'});
  const created = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'derived-project')!;
  assert.equal(created.projectId, null, '终端此时还没有归属');

  // 终端后来才被放进分组——这正是原来永远补不上的那一格。
  f.store.setSessionProject('web-derived-project', project.id);
  f.bridge.publish('web-derived-project', {type: 'message', eventId: 'e2', role: 'user', content: '又一句'});
  assert.equal(f.store.conversations.get(created.id).projectId, project.id);
});

test('人自己选过的归属，后续观测不会把它重算掉', t => {
  /*
    **这一条是整组里最要紧的。** 归属原来没有「来源」这一格（标题有 title_origin），
    所以分不出「人选的」和「创建时从终端捡的」。分不出就不能重算——一重算就会把人手动
    挪进去的对话自己挪回来，而且是静默的。
  */
  const f = fixture(t);
  const chosen = f.store.createProject({id: 'chosen', name: '我选的', color: '#fff'});
  const derived = f.store.createProject({id: 'derived', name: '推出来的', color: '#000'});
  f.bind('pinned-project');
  f.bridge.publish('web-pinned-project', {type: 'message', eventId: 'e1', role: 'user', content: '一句话'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'pinned-project')!;

  f.store.conversations.patch(record.id, {revision: record.revision, projectId: chosen.id});
  // 终端归到另一个分组；推导会算出 derived，但不该覆盖人选的 chosen。
  f.store.setSessionProject('web-pinned-project', derived.id);
  f.bridge.publish('web-pinned-project', {type: 'message', eventId: 'e2', role: 'user', content: '又一句'});
  assert.equal(f.store.conversations.get(record.id).projectId, chosen.id);
});

test('人把对话移出分组也算人的选择，不会被重算成有归属', t => {
  // 设成「无分组」和设成某个分组一样是人的决定，同样要盖章。
  const f = fixture(t);
  const project = f.store.createProject({id: 'p2', name: '分组二', color: '#fff'});
  f.bind('cleared-project');
  f.store.setSessionProject('web-cleared-project', project.id);
  f.bridge.publish('web-cleared-project', {type: 'message', eventId: 'e1', role: 'user', content: '一句话'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'cleared-project')!;
  assert.equal(record.projectId, project.id);

  f.store.conversations.patch(record.id, {revision: record.revision, projectId: null});
  f.bridge.publish('web-cleared-project', {type: 'message', eventId: 'e2', role: 'user', content: '又一句'});
  assert.equal(f.store.conversations.get(record.id).projectId, null, '移出去了就该留在外面');
});

test('人起的名字挡得住推导出来的——上面那条 metadata 用例挡不住这个', t => {
  /*
    **变异测试发现的**：把「推导标题让开人设的标题」这道判断删掉，所有用例照样绿。
    原因是上面那条 metadata 用例发的消息**没有 role**，于是根本推不出标题，
    那道判断从来没被走到过。一条带 role 的用户消息才真的会去抢标题。
  */
  const f = fixture(t); f.bind('user-vs-derived');
  f.bridge.publish('web-user-vs-derived', {type: 'message', eventId: 'e1', role: 'user', content: '第一句问话'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'user-vs-derived')!;
  const renamed = f.store.conversations.patch(record.id, {revision: record.revision, title: '我自己起的名字'});

  f.bridge.publish('web-user-vs-derived', {type: 'message', eventId: 'e2', role: 'user', content: '第二句问话'});
  assert.equal(f.store.conversations.get(renamed.id).title, '我自己起的名字');
  assert.equal(f.store.conversations.get(renamed.id).titleOrigin, 'user');
});

test('终端被移出分组之后，对话的归属跟着清掉，不留旧值', t => {
  /*
    旧归属在那条终端离开分组之后就是个**已经不成立的说法**，留着比空着更容易把人带偏：
    在分组里找这条对话会找到它，而它其实已经不属于那儿了。
  */
  const f = fixture(t);
  const project = f.store.createProject({id: 'leaving', name: '会被移出的分组', color: '#fff'});
  f.bind('project-cleared-by-terminal');
  f.store.setSessionProject('web-project-cleared-by-terminal', project.id);
  f.bridge.publish('web-project-cleared-by-terminal', {type: 'message', eventId: 'e1', role: 'user', content: '一句话'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'project-cleared-by-terminal')!;
  assert.equal(record.projectId, project.id);

  f.store.setSessionProject('web-project-cleared-by-terminal', null);
  f.bridge.publish('web-project-cleared-by-terminal', {type: 'message', eventId: 'e2', role: 'user', content: '又一句'});
  assert.equal(f.store.conversations.get(record.id).projectId, null);
});

test('同一条对话换了终端时，归属跟最近那一代走', t => {
  /*
    一条 CLI 会话可以先后在两个终端里跑（重新绑定、换窗口）。归属要跟**最近**那一代——
    取最早那一代的话，换了终端之后归属永远停在第一次的位置上，而且不报错。
  */
  const f = fixture(t);
  const first = f.store.createProject({id: 'first', name: '先前的', color: '#fff'});
  const second = f.store.createProject({id: 'second', name: '后来的', color: '#000'});
  f.bind('moved-conversation', 'terminal-a');
  f.store.setSessionProject('terminal-a', first.id);
  f.bridge.publish('terminal-a', {type: 'message', eventId: 'e1', role: 'user', content: '在第一个终端里'});
  const record = f.store.conversations.list({state: 'all'}).items.find(item => item.source.nativeSessionId === 'moved-conversation')!;
  assert.equal(record.projectId, first.id);

  /*
    同一条 CLI 会话换到另一个终端里继续。先解掉原来那条绑定——一条 CLI 会话同一时刻只能
    绑一个终端，桥会直接拒绝（`native session already bound`）。

    **只解绑定，不删那条终端。** 删掉的话它的 sessions 行就没了，那一代在 JOIN 里被过滤掉，
    表里只剩一代——「取最近那一代」和「取最早那一代」就分不出来了，这条用例也就白写了
    （变异测试发现：第一版正是这么写的，把 DESC 改成 ASC 照样绿）。
  */
  f.store.aiSessions.remove('terminal-a');
  const fresh = createAiSessionBridge({storage: f.store.aiSessions});
  f.store.upsertSession({id: 'terminal-b', cwd: f.dir});
  f.store.setSessionProject('terminal-b', second.id);
  fresh.bind({webSessionId: 'terminal-b', terminalInstanceId: 'instance-terminal-b', cliId: 'omp', nativeSessionId: 'moved-conversation'});
  fresh.publish('terminal-b', {type: 'message', eventId: 'e2', role: 'user', content: '在第二个终端里'});
  assert.equal(f.store.conversations.get(record.id).projectId, second.id);
});
