import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readOpenCodeTranscript } from '../src/opencode.js';
import { isOpenCodeUserReceipt, parseOpenCodeStatus } from '../src/opencode-control.js';

async function fixture(run: (url: string, state: any) => Promise<void>) {
  const state: any = { session: { id: 'ses_test', time: { created: 100 }, directory: '/tmp/test' },
    rows: [{ info: { id: 'msg_a', sessionID: 'ses_test', role: 'assistant', time: { created: 200 } }, parts: [{ type: 'text', text: 'first' }] }], requests: [] };
  const server = createServer((req, res) => {
    state.requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/session/status')) {
      res.statusCode = state.statusCode ?? 200;
      res.end(JSON.stringify(state.status ?? {})); return;
    }
    if (state.huge) { res.setHeader('Content-Length', 5 * 1024 * 1024); res.end(); return; }
    res.end(JSON.stringify(req.url?.includes('/message') ? state.rows : state.session));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as any).port}/?directory=%2Ftmp%2Ftest`, state); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('explicit server snapshot detects edits with stable IDs and bounded details', async () => fixture(async (url, state) => {
  const first = await readOpenCodeTranscript(url, 'ses_test');
  assert.equal(first.items[0].content, 'first');
  assert.equal(first.checkpoint.adapter, 'opencode-api');
  assert.equal(first.checkpoint.offset, 0);
  assert.match(state.requests[1], /limit=100/);
  assert.match(state.requests[1], /directory=/);
  const idle = await readOpenCodeTranscript(url, 'ses_test', first.checkpoint);
  assert.equal(idle.reset, false); assert.equal(idle.items.length, 0);
  state.rows[0].parts = [{ type: 'reasoning', text: 'recorded thought' }, { type: 'tool', tool: 'bash', callID: 'call_x', state: { status: 'completed', input: { command: 'echo ok' }, output: 'x'.repeat(100000) } }];
  const edited = await readOpenCodeTranscript(url, 'ses_test', first.checkpoint);
  assert.equal(edited.reset, true); assert.equal(edited.items[0].eventId, first.items[0].eventId);
  assert.notEqual(edited.items[0].data.detail.hash, first.items[0].data.detail.hash);
  assert.equal(edited.items[0].data.truncated, true);
  assert.equal(edited.details[0].data.truncated, false);
  assert.equal(edited.items[0].data.parts[2].toolCallId, 'call_x');
}));

test('rejects identity mismatch, endpoint replacement, unbounded upstream and credentials', async () => fixture(async (url, state) => {
  const first = await readOpenCodeTranscript(url, 'ses_test');
  state.session.time.created++;
  await assert.rejects(readOpenCodeTranscript(url, 'ses_test', first.checkpoint), /session_identity_changed/);
  state.session.time.created--;
  state.rows[0].info.sessionID = 'other';
  await assert.rejects(readOpenCodeTranscript(url, 'ses_test'), /session_mismatch/);
  state.rows = Array(101).fill({});
  await assert.rejects(readOpenCodeTranscript(url, 'ses_test'), /unsupported_message_limit/);
  state.huge = true;
  await assert.rejects(readOpenCodeTranscript(url, 'ses_test'), /response_too_large/);
  await assert.rejects(readOpenCodeTranscript('http://user:secret@localhost/', 'ses_test'), /invalid_endpoint/);
}));

test('window limit and unknown parts are partial, not complete history claims', async () => fixture(async (url, state) => {
  state.rows = Array.from({ length: 100 }, (_, i) => ({ info: { id: `msg_${i}`, role: 'user', sessionID: 'ses_test' }, parts: [{ type: 'future' }] }));
  const batch = await readOpenCodeTranscript(url, 'ses_test');
  assert.equal(batch.checkpoint.status, 'partial'); assert.equal(batch.checkpoint.skipped, 101);
  assert.equal(batch.checkpoint.state.coverage, 'bounded_snapshot');
}));

test('native state changes are visible without replaying unchanged messages; status failure preserves transcript', async () => fixture(async (url, state) => {
  state.status = { ses_test: { type: 'busy' } };
  const busy = await readOpenCodeTranscript(url, 'ses_test');
  assert.equal(busy.checkpoint.state.nativeStatus, 'busy');
  state.status = { ses_test: { type: 'idle' } };
  const idle = await readOpenCodeTranscript(url, 'ses_test', busy.checkpoint);
  assert.equal(idle.checkpoint.state.nativeStatus, 'idle');
  assert.equal(idle.bytesRead, 0); assert.equal(idle.reset, false); assert.deepEqual(idle.items, []);
  state.statusCode = 500; state.rows[0].parts[0].text = 'still readable';
  const failed = await readOpenCodeTranscript(url, 'ses_test', idle.checkpoint);
  assert.equal(failed.checkpoint.state.nativeStatus, 'unknown');
  assert.equal(failed.items[0].content, 'still readable');
}));

test('status and native message receipt never infer another session or synthetic user input', () => {
  assert.equal(parseOpenCodeStatus({ other: { type: 'busy' } }, 'ses_test'), 'unknown');
  assert.equal(parseOpenCodeStatus({ ses_test: { type: 'future' } }, 'ses_test'), 'unknown');
  assert.equal(parseOpenCodeStatus({ ses_test: { type: 'retry', attempt: 2 } }, 'ses_test'), 'retry');
  const row = { info: { id: 'msg_test', sessionID: 'ses_test', role: 'user' }, parts: [{ type: 'text', text: 'hello\r\nworld' }] };
  assert.equal(isOpenCodeUserReceipt(row, 'ses_test', 'msg_test', 'hello\nworld'), true);
  assert.equal(isOpenCodeUserReceipt(row, 'ses_other', 'msg_test', 'hello\nworld'), false);
  assert.equal(isOpenCodeUserReceipt(row, 'ses_test', 'msg_other', 'hello\nworld'), false);
  assert.equal(isOpenCodeUserReceipt({ ...row, parts: [{ ...row.parts[0], synthetic: true }] }, 'ses_test', 'msg_test', 'hello\nworld'), false);
  assert.equal(isOpenCodeUserReceipt({ ...row, parts: [{ type: 'file' }, ...row.parts] }, 'ses_test', 'msg_test', 'hello\nworld'), false);
});
