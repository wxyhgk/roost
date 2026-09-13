import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCli, listCliAdapters, getCliAdapter, planImageInsertion } from '../src/index.ts';

test('recognizes native executable names, installed launcher scripts and Claude version paths', () => {
  for (const [command, expected] of [
    ['/opt/bin/qwen --model test', 'qwen'], ['/opt/bin/claude-code', 'claude'],
    ['/Users/u/.local/share/claude/versions/2.1.261', 'claude'],
    ['/Users/u/.opencode/bin/opencode', 'opencode'], ['/Users/u/.grok/bin/grok', 'grok'],
    ['"C:\\Program Files\\Codex\\codex.exe"', 'codex'],
    ['node --expose-gc /opt/node_modules/@qwen-code/qwen-code/cli.js --prompt claude', 'qwen'],
    ['node --require /tmp/preflight.cjs /opt/node_modules/@anthropic-ai/claude-code/cli.js', 'claude'],
    ['node /opt/node_modules/@openai/codex/bin/codex.js', 'codex'],
  ]) assert.equal(detectCli(command), expected, command);
});

test('does not mistake prompt text, shell commands or arbitrary script arguments for the running CLI', () => {
  for (const command of ['', 'echo codex', 'rg qwen', 'zsh -c "qwen"', 'node -e "codex"',
    'node /tmp/server.js /opt/node_modules/@qwen-code/qwen-code/cli.js',
    'node /tmp/server /opt/node_modules/@openai/codex/bin/codex.js',
    'qwen-unrelated', 'cat /tmp/claude']) assert.equal(detectCli(command), null, command);
});

test('all adapters share path framing but only the explicitly verified version is verified', () => {
  for (const adapter of listCliAdapters()) {
    const plan = planImageInsertion({ cli: adapter.id, path: '/tmp/screenshot with spaces.png' });
    assert.equal(plan.kind, 'paste');
    if (plan.kind !== 'paste') throw new Error('missing paste');
    assert.equal(plan.data, adapter.id === 'codex'
      ? "\x1b[200~'/tmp/screenshot with spaces.png'\x1b[201~"
      : '\x1b[200~/tmp/screenshot with spaces.png\x1b[201~');
    assert.equal(plan.requiresConfirmation, false);
    assert.equal(plan.verification, 'unverified');
  }
  const qwen = planImageInsertion({ cli: 'qwen', path: '/tmp/image.png', version: '0.21.14' });
  assert.equal(qwen.kind === 'paste' && qwen.verification, 'verified');
  const upgraded = planImageInsertion({ cli: 'qwen', path: '/tmp/image.png', version: '0.21.15' });
  assert.equal(upgraded.kind === 'paste' && upgraded.requiresConfirmation, false);
});

test('unknown CLI and control-bearing or relative paths never produce terminal input', () => {
  assert.deepEqual(planImageInsertion({ cli: null, path: '/tmp/a.png' }), {kind:'unsupported',reason:'unknown-cli'});
  for (const path of ['relative.png', '/tmp/a.png\n', '/tmp/a\x1b[201~.png', '/tmp/a\0.png', '/tmp/a.svg']) {
    assert.deepEqual(planImageInsertion({cli:'qwen',path}), {kind:'unsupported',reason:'invalid-path'});
  }
});

test('adapter metadata is immutable and unknown identifiers do not inherit support', () => {
  assert.equal(getCliAdapter('shell'), null);
  assert.ok(Object.isFrozen(listCliAdapters()));
  for (const a of listCliAdapters()) { assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.verifiedVersions)); }
});


test('Codex paths round-trip through shell tokenization without splitting or losing punctuation', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const path of ["/Users/test/Library/Application Support/Index/a.png", "/tmp/user's screenshot.png", '/tmp/a"b\\c.png']) {
    const plan = planImageInsertion({ cli: 'codex', path });
    assert.equal(plan.kind, 'paste');
    if (plan.kind !== 'paste') throw new Error('missing paste');
    const payload = plan.data.slice(6, -6);
    // Python shlex provides an independent parser for the POSIX escaping contract.
    const decoded = JSON.parse(execFileSync('python3', ['-c', 'import shlex,json,sys;print(json.dumps(shlex.split(sys.argv[1])))', payload], {encoding:'utf8'}));
    assert.deepEqual(decoded, [path]);
    assert.equal(plan.requiresConfirmation, false);
  }
});
