import { ensureSdfRecord, replaceFirstSdfRecord, splitSdfRecords } from '../src/molecule/sdf.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffMolecule, moleculeReference } from '../src/molecule/handoff.ts';
import { claimTerminalSession, getAttachmentTarget } from '../src/features/terminal/handles.ts';
import type { TermHandle } from '../src/features/terminal/types.ts';
import { planImageInsertion } from '@roost/cli-adapters';
import { t } from '@roost/i18n';

const initial = { sessionId: 's', instanceId: 'pty1', epoch: 1 };
function fixture() {
  let target: typeof initial | null = initial;
  const sent: string[] = [];
  const attachment = { sessionId: 's', instanceId: 'pty1', path: '/tmp/a b.png', insertion: planImageInsertion({ cli: 'codex', path: '/tmp/a b.png' }) };
  return {
    sent, attachment, change: (next: typeof initial | null) => { target = next; },
    deps: { target: () => target, upload: async () => attachment, send: (_id: string, data: string) => { sent.push(data); return 'sent' as const; } },
  };
}
const run = (f: ReturnType<typeof fixture>) => handoffMolecule('s', '/project/a b.mol', new Blob(['png']), new AbortController().signal, f.deps);
test('molecule handoff inserts source and quoted image as paste without Enter', async () => {
  const f = fixture(); await run(f);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /a b\.mol/); assert.match(f.sent[0], /'\/tmp\/a b\.png'/);
  assert.ok(f.sent[0].endsWith('\x1b[201~')); assert.ok(!/[\r\n]/.test(f.sent[0]));
});
test('connection change during image upload prevents insertion', async () => {
  const f = fixture(); f.deps.upload = async () => { f.change({ ...initial, epoch: 2 }); return f.attachment; };
  // 直接比对文案对象而不是写死的中文片段：改文案不该让测试因为无关原因变红。
  await assert.rejects(run(f), { message: t.files.molecule.connectionChanged }); assert.deepEqual(f.sent, []);
});
test('offline, wrong attachment instance, unsupported CLI and upload failure never send', async () => {
  const offline = fixture(); offline.change(null); await assert.rejects(run(offline), { message: t.files.molecule.terminalNotReady });
  const wrong = fixture(); wrong.attachment.instanceId = 'other'; await assert.rejects(run(wrong), { message: t.files.molecule.connectionChanged });
  const unknown = fixture(); unknown.attachment.insertion = { kind: 'unsupported', reason: 'unknown-cli' }; await assert.rejects(run(unknown), { message: t.files.molecule.cliUnsupported });
  const failed = fixture(); failed.deps.upload = async () => { throw new Error('offline'); }; await assert.rejects(run(failed), /offline/);
  for (const f of [offline, wrong, unknown, failed]) assert.deepEqual(f.sent, []);
});
test('molecule source path rejects terminal control injection', () => {
  assert.throws(() => moleculeReference('/tmp/a\x1b[201~.mol', ''), { message: t.files.molecule.pathUnsupported });
});
test('attachment target belongs to current terminal lease; stale cleanup cannot remove new owner', () => {
  const old = claimTerminalSession('s'); old.register({} as TermHandle, () => 'sent', () => initial);
  assert.deepEqual(getAttachmentTarget('s'), initial);
  const fresh = claimTerminalSession('s'); assert.equal(getAttachmentTarget('s'), null);
  fresh.register({} as TermHandle, () => 'sent', () => ({ ...initial, epoch: 2 }));
  old.dispose(); assert.equal(getAttachmentTarget('s')?.epoch, 2);
  fresh.dispose(); assert.equal(getAttachmentTarget('s'), null);
});

test('sdf records split on $$$$ lines and keep the rest byte-identical', () => {
  assert.deepEqual(splitSdfRecords(''), []);
  assert.deepEqual(splitSdfRecords('mol-only'), ['mol-only']);
  const content = 'R1\n$$$$\nR2 line1\nR2 line2\n$$$$\n';
  assert.deepEqual(splitSdfRecords(content), ['R1\n$$$$', 'R2 line1\nR2 line2\n$$$$\n']);
  assert.equal(replaceFirstSdfRecord(content, 'F'), 'F\n$$$$\nR2 line1\nR2 line2\n$$$$\n');
  assert.equal(replaceFirstSdfRecord(content, 'F\n$$$$\n'), 'F\n$$$$\nR2 line1\nR2 line2\n$$$$\n');
});

test('sdf single record save normalizes to one $$$$-terminated record', () => {
  assert.equal(replaceFirstSdfRecord('old', 'F'), 'F\n$$$$\n');
  assert.equal(ensureSdfRecord('F\n$$$$\n   \n'), 'F\n$$$$\n');
});
