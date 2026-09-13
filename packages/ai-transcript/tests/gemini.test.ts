import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGeminiTranscript } from '../src/gemini.ts';

async function fixture(run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-reader-'));
  try { await run(join(dir, 'session.json')); } finally { await rm(dir, { recursive: true, force: true }); }
}
const session = () => ({ sessionId: 'native', projectHash: 'project', startTime: '2026-09-09T00:00:00Z', messages: [
  { id: 'u', type: 'user', timestamp: '2026-09-09T00:00:00Z', content: [{ text: '你好' }] },
  { id: 'a', type: 'gemini', timestamp: '2026-09-09T00:00:01Z', content: 'reply', thoughts: [{ subject: 'Plan', description: 'inspect' }],
    toolCalls: [{ id: 't', name: 'shell', args: { command: 'pwd' }, status: 'success', result: [{ functionResponse: { name: 'shell', response: { output: '/tmp' } } }] }] },
] });

test('Gemini snapshot preserves IDs, tool correlation, revisions and non-ASCII', async () => fixture(async file => {
  const data = session(); await writeFile(file, JSON.stringify(data));
  const first = await readGeminiTranscript(file, 'native');
  assert.equal(first.items[0].content, '你好');
  assert.equal(first.items[1].data.parts.find(p => p.type === 'tool_result')?.toolCallId, 't');
  assert.equal(first.checkpoint.status, 'caught_up');
  assert.equal((await readGeminiTranscript(file, 'native', first.checkpoint)).reset, false);
  data.messages[1].content = 'revised'; await writeFile(file, JSON.stringify(data));
  const next = await readGeminiTranscript(file, 'native', first.checkpoint);
  assert.equal(next.reset, true); assert.equal(next.items[1].eventId, first.items[1].eventId);
  assert.notEqual(next.items[1].data.detail.hash, first.items[1].data.detail.hash);
}));

test('Gemini fails closed on wrong identity, reused identity, duplicate IDs and partial write', async () => fixture(async file => {
  const data = session(); await writeFile(file, JSON.stringify(data));
  const first = await readGeminiTranscript(file, 'native');
  await assert.rejects(readGeminiTranscript(file, 'other'), /session_mismatch/);
  data.startTime = '2026-09-10T00:00:00Z'; await writeFile(file, JSON.stringify(data));
  await assert.rejects(readGeminiTranscript(file, 'native', first.checkpoint), /session_identity_changed/);
  data.messages[1].id = 'u'; await writeFile(file, JSON.stringify(data));
  await assert.rejects(readGeminiTranscript(file, 'native'), /invalid_message/);
  await writeFile(file, '{"sessionId":'); await assert.rejects(readGeminiTranscript(file, 'native'), /invalid_transcript/);
  await writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(readGeminiTranscript(file, 'native'), /transcript_too_large/);
}));

test('Gemini reports unsupported parts and bounds previews/details', async () => fixture(async file => {
  const data = session(); data.messages[0].content = [{ text: 'x'.repeat(300000) }, { inlineData: { data: 'private-image' } }] as any;
  await writeFile(file, JSON.stringify(data)); const result = await readGeminiTranscript(file, 'native');
  assert.equal(result.checkpoint.status, 'partial'); assert.equal(result.items[0].data.truncated, true);
  assert.ok(result.items[0].content.length < 66000); assert.ok(result.details[0].content.length < 263000);
  assert.ok(!result.items[0].content.includes('private-image'));
}));
