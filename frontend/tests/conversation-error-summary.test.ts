/*
  `toolErrorSummary()`：一次失败的工具调用，摘要位上该写哪一行。

  钉两件事，一件比一件重要：
  1. 拿得出一行时，那一行是**人能读的纯文本**——不带 ANSI 转义序列，不是一坨 JSON。
  2. 拿不出时是 **null**，不是空串、不是原文、不是编出来的一句话。

  起因是一次真实的坑：把整段 `block.result` 当 errorSummary 递给 ToolRow，摘要行里直接
  吐出了 `ESC[32m` 这种东西。
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolErrorSummary } from '../src/features/conversations/tools/error-summary.ts';
import type { ToolBlock } from '../src/features/conversations/tools/SummaryRow.tsx';

/** 转义序列不能直接写进源码（编辑器和 grep 都会被它搞坏），从码位拼。 */
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

/** 默认就是「跑完了，失败了」——这个函数只对这一种状态有输出。 */
function block(result: string | null, extra: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: 'tool', id: 't1', name: 'Bash', args: 'npm test', result, failed: true, ...extra };
}

test('带 ANSI 的输出：摘要里一个转义序列都不留', () => {
  const result = `${ESC}[1;31mError: ENOENT: no such file or directory, open '/tmp/x'${ESC}[0m\n    at Object.openSync (node:fs:596:3)`;
  // `Error:` 前缀被剥掉是上游定的规矩（`/^error:/i`）：摘要位左边已经写着「失败」了，
  // 再重复一遍 Error 只是占掉本来就不够用的一行宽度。
  assert.equal(toolErrorSummary(block(result)), "ENOENT: no such file or directory, open '/tmp/x'");
  assert.equal(toolErrorSummary(block(result))?.includes(ESC), false);
});

test('第一行是纯控制序列时，往下找第一条有可见字符的行', () => {
  // 清行 + 隐藏光标：终端里这一行什么都不显示，真正那句话在下一行。上游死守「第一行」，
  // 在我们这种原始终端输出上就是摘要位空着。
  const result = `${ESC}[2K${ESC}[?25l\n${ESC}[31mnpm ERR! code ELIFECYCLE${ESC}[0m\n${ESC}[31mnpm ERR! errno 1${ESC}[0m`;
  assert.equal(toolErrorSummary(block(result)), 'npm ERR! code ELIFECYCLE');
});

test('回车覆写：取这一行最后长成的样子，不是原始字节', () => {
  assert.equal(toolErrorSummary(block(`done${CR}fail\nrest`)), 'fail');
});

test('纯文本多行：只取第一行', () => {
  const result = 'fatal: not a git repository (or any of the parent directories): .git\nhint: Use "git init"';
  assert.equal(toolErrorSummary(block(result)), 'fatal: not a git repository (or any of the parent directories): .git');
});

test('前后空行不影响取到的那一行', () => {
  assert.equal(toolErrorSummary(block('\n\n  boom  \n\nmore')), 'boom');
});

test('JSON 字符串：挤出 error 字段，而不是把花括号倒出来', () => {
  assert.equal(
    toolErrorSummary(block('{"ok":false,"error":"connect ECONNREFUSED 127.0.0.1:5432"}')),
    'connect ECONNREFUSED 127.0.0.1:5432',
  );
});

test('JSON 字符串：error 是对象时取它的 message', () => {
  assert.equal(
    toolErrorSummary(block('{"error":{"code":"E_PERM","message":"permission denied: /etc/hosts"}}')),
    'permission denied: /etc/hosts',
  );
});

test('JSON 字符串：没有 error 就退到 message / content', () => {
  assert.equal(toolErrorSummary(block('{"message":"tool exited with code 2"}')), 'tool exited with code 2');
  assert.equal(toolErrorSummary(block('{"content":"stack overflow"}')), 'stack overflow');
});

test('JSON 字符串：一个错误字段都没有时，落回原文那一行——不编', () => {
  // 这不是「猜」：它是这次调用真实的输出全文，而且只有一行。宁可让人看见花括号，
  // 也不要把「这次失败了但我们不知道为什么」写成一句像模像样的错误。
  assert.equal(toolErrorSummary(block('{"count":0}')), '{"count":0}');
});

test('半截 JSON（被上游截断）当普通文本处理，不是错误', () => {
  assert.equal(toolErrorSummary(block('{"error":"disk ful')), '{"error":"disk ful');
});

test('JSON 里的 tool_use_result：必须以 error: 开头才算，前缀剥掉', () => {
  assert.equal(toolErrorSummary(block('{"tool_use_result":"error: file not found"}')), 'file not found');
  // 不以 error: 开头就不是错误声明，继续往后找——这里后面什么都没有，于是落回原文。
  assert.equal(toolErrorSummary(block('{"tool_use_result":"wrote 3 files"}')), '{"tool_use_result":"wrote 3 files"}');
});

test('空串 → null', () => {
  assert.equal(toolErrorSummary(block('')), null);
});

test('result 是 null → null', () => {
  assert.equal(toolErrorSummary(block(null)), null);
});

test('只有空白行 → null，不是空串', () => {
  const summary = toolErrorSummary(block('   \n\n\t\n  '));
  assert.equal(summary, null);
});

test('整段只有控制序列、一个可见字符都没有 → null', () => {
  assert.equal(toolErrorSummary(block(`${ESC}[2K${ESC}[?25l\n${ESC}[0m`)), null);
});

test('没失败的调用不给错误摘要', () => {
  assert.equal(toolErrorSummary(block('all 42 tests passed', { failed: false })), null);
});

test('还在跑的调用不给错误摘要', () => {
  assert.equal(toolErrorSummary(block(null, { failed: false })), null);
});

test('被拒绝的调用不给错误摘要——那是没让它跑，不是故障', () => {
  // denied 的 result 里常常写着 "The user doesn't want to proceed"。把它放进错误摘要位，
  // 等于在对话里报告一次没发生过的失败。
  assert.equal(
    toolErrorSummary(block("The user doesn't want to proceed with this tool use.", { denied: true, failed: true })),
    null,
  );
});
