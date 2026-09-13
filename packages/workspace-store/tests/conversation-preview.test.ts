import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAiSessionBridge, type BridgeEvent } from '@roost/ai-session-bridge';
import { createWorkspaceStore } from '../src/index.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-preview-'));
  const store = createWorkspaceStore({ dataDir: dir });
  const bridge = createAiSessionBridge({ storage: store.aiSessions });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function bind(id: string, cliId = 'omp') {
    store.upsertSession({ id, cwd: dir });
    bridge.bind({ webSessionId: id, terminalInstanceId: id, cliId, nativeSessionId: 'same-native' });
  }
  const publish = (id: string, eventId: string, content: string, extra: Partial<BridgeEvent> = {}) =>
    bridge.publish(id, { type: 'message', role: 'user', eventId, content, ...extra });
  const item = (cli = 'omp') => store.conversations.list({ state: 'all' }).items.find(row => row.source.cliId === cli)!;
  return { store, bridge, bind, publish, item };
}

test('empty/assistant-only histories return null; first available user text is normalized without changing title', t => {
  const f = fixture(t); f.bind('s');
  assert.equal(f.item().firstUserMessagePreview, null);
  f.publish('s', 'assistant', 'not the question', { role: 'assistant' });
  f.publish('s', 'tool', 'not the question either', { role: 'tool' });
  f.publish('s', 'empty', '\n\t\u3000');
  assert.equal(f.item().firstUserMessagePreview, null);
  const title = f.item().title;
  f.publish('s', 'user', '  请帮我\n\t 修改　前端  布局  ');
  f.publish('s', 'later', 'later question');
  assert.equal(f.item().firstUserMessagePreview, '请帮我 修改 前端 布局');
  assert.equal(f.item().title, title);
});

test('120 code point limit preserves Chinese and astral Unicode without adding an ellipsis', t => {
  const f = fixture(t); f.bind('s');
  const text = '化学😀'.repeat(60);
  f.publish('s', 'question', text);
  assert.equal(f.item().firstUserMessagePreview, Array.from(text).slice(0, 120).join(''));
  assert.equal(Array.from(f.item().firstUserMessagePreview!).length, 120);
});

test('earlier timestamped backfill replaces the preview and revisions preserve original message position', t => {
  const f = fixture(t); f.bind('s');
  f.publish('s', 'later', 'recent question', { createdAt: 200 });
  assert.equal(f.item().firstUserMessagePreview, 'recent question');
  f.publish('s', 'earlier', 'original question', { createdAt: 100 });
  assert.equal(f.item().firstUserMessagePreview, 'original question');
  f.bridge.ingestTranscript('s', f.bridge.get('s')!.generation, {
    checkpoint: { path: '/missing/native-log', fingerprint: 'test', offset: 1, pending: '', discarding: false, tail: '', fileSize: 1, skipped: 0, active: true, status: 'caught_up' },
    reset: false,
    items: [{ eventId: 'earlier', type: 'message', role: 'user', content: 'corrected original question', createdAt: 300,
      data: { source: 'transcript', nativeMessageId: 'earlier', parentId: null, parts: [], truncated: false,
        detail: { path: '/missing/native-log', fingerprint: 'test', offset: 0, length: 1, nativeSessionId: 'same-native', recordId: 'earlier', hash: 'fixture' } } }],
  });
  assert.equal(f.item().firstUserMessagePreview, 'corrected original question');
  f.publish('s', 'unknown-time', 'unknown position');
  assert.equal(f.item().firstUserMessagePreview, 'recent question', 'incomplete times fall back to saved order');
});

test('previews remain isolated by CLI/source across pagination, filters and terminal deletion without native reads', t => {
  const f = fixture(t); f.bind('a'); f.bind('b', 'claude');
  f.publish('a', 'user', 'omp question', { data: { truncated: true, detail: { path: '/missing/native-log.jsonl', hash: 'fixture' } } });
  f.publish('b', 'user', 'claude question');
  const a = f.item(); f.store.deleteSessionRecord('a');
  assert.equal(f.item().firstUserMessagePreview, 'omp question');
  for (const sort of ['created', 'activity'] as const) {
    const first = f.store.conversations.list({ sort, limit: 1 });
    const next = f.store.conversations.list({ sort, limit: 1, cursor: first.nextCursor! });
    assert.deepEqual(new Set([...first.items, ...next.items].map(row => row.firstUserMessagePreview)), new Set(['omp question', 'claude question']));
  }
  assert.equal(f.store.conversations.list({ terminalId: 'a', q: 'omp question' }).items[0]!.id, a.id);
  const revision = f.store.conversations.get(a.id).revision;
  f.store.conversations.patch(a.id, { revision, archived: true });
  assert.equal(f.store.conversations.list({ state: 'archived' }).items[0]!.firstUserMessagePreview, 'omp question');
  assert.equal(f.store.conversations.list().items.length, 1);
});

/*
  一条 agent 回合的**结构**（调用了哪个工具、参数大概是什么、结果成没成）在 parts 里。
  列表要靠它把回合渲染成「文本 + 工具调用」，而不是一坨纯文本。

  超过 128KB 的消息会被裁剪存预览，而裁剪原本把 parts 整个丢掉——于是同一个会话里，
  小消息看得出工具调用、大消息只剩一段文字，**分界线是一个用户看不见的字节数**。
  裁剪必须保留轮廓：完整参数和结果仍然只在正文里，按需回读。
*/
test('an oversized message keeps the outline of its parts instead of losing them', t => {
  const f = fixture(t); f.bind('s');
  const huge = 'x'.repeat(400 * 1024);
  f.publish('s', 'big', 'ran a command', { role: 'assistant', data: { source: 'transcript',
    nativeMessageId: 'big', parentId: null, truncated: false, detail: { path: '/t.jsonl', hash: 'h' },
    parts: [
      { type: 'text', text: 'ran a command' },
      { type: 'tool_call', name: 'Bash', toolCallId: 'call-1', text: 'Bash: ' + huge },
      { type: 'tool_result', toolCallId: 'call-1', text: huge },
    ] } });
  const page = f.store.conversations.pageMessages(f.item().id, {});
  const parts = (page.items.at(-1)!.event.data as { parts?: { type?: string; name?: string; toolCallId?: string; text?: string }[] }).parts!;
  assert.equal(parts.length, 3, '裁剪之后每一段都还在');
  assert.deepEqual(parts.map(p => p.type), ['text', 'tool_call', 'tool_result']);
  assert.equal(parts[1].name, 'Bash');
  assert.equal(parts[1].toolCallId, parts[2].toolCallId, '调用与结果仍然配得上对');
  assert.ok(parts[1].text!.length <= 200 && parts[2].text!.length <= 200, '只留轮廓，不搬正文');
});
