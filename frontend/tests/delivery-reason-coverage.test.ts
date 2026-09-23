/*
  每一个会走到用户眼前的「投递原因」，都必须有一句人话。

  `deliveryReason.ts` 的注释一开始就写着：这些原因是一个**封闭集合**，没有理由不逐条
  给说法。但它漂了——2026-09-22 用户在界面上看到的是

      暂时不能投递（acceptance_uncertain）

  一个原样漏出来的内部标识符。那一次漏的不止一个：acceptance_timeout、awaiting_paste_echo、
  write_failed、daemon_restarted、submission_boundary_unknown… 一共十一个，全都掉进
  `queuedOther` 那条兜底。

  **靠注释约束不住这种漂移**，所以这条用例去源码里把集合数出来，逐个要说法。
  新加一个原因却不给句子，这里直接挂——而不是等用户在界面上看见它。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queuedText } from '../src/features/conversations/deliveryReason';

const root = new URL('../../', import.meta.url).pathname;
const read = (path: string) => readFileSync(root + path, 'utf8');
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(m => m[1]);

/** 取一个函数的函数体：从它的签名到下一个已知签名之间。找不到锚点就是这条用例失效了。 */
function body(text: string, from: string, to: string): string {
  const start = text.indexOf(from), end = text.indexOf(to);
  assert.ok(start >= 0 && end > start, `锚点 ${from} / ${to} 不在了——这条用例本身失效，请修它而不是删它`);
  return text.slice(start, end);
}

function emittedReasons(): Set<string> {
  const owner = read('packages/terminal-daemon/src/ai-command-owner.ts');
  const reasons = new Set<string>([
    // 写入闸：「现在为什么不能写」。
    ...all(body(owner, 'function reason(', 'function control('), /return '([a-z_]+)'/g),
    // control() 把闸的结论和「有条命令悬着」合成一个对外的原因。只取那个三元表达式，
    // 别把同一段里的 CLI 名和状态值（claude / qwen / uncertain）也当成原因。
    ...all(body(owner, 'function control(', 'function submitPasted(')
      .replace(/^[\s\S]*?reason:/, '').replace(/,inputEpoch[\s\S]*$/, ''), /'([a-z_]+)'/g),
    // 命令自己记的原因，经 finishFromCommand 传到投递上。
    ...all(owner, /reason:'([a-z_]+)'/g),
    ...all(read('packages/workspace-store/src/ai-commands.ts'), /reason:'([a-z_]+)'/g),
    // 认领失败里说得出口的那几种（peer-delivery.ts 的 CLAIM_REASONS）。
    ...all(read('packages/terminal-daemon/src/peer-delivery.ts'),
      /CLAIM_REASONS[\s\S]*?\[([\s\S]*?)\]/g).flatMap(list => [...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1])),
    // 投递排队与不确定态。
    ...all(read('packages/terminal-daemon/src/peer-delivery.ts'), /setQueuedReason\([^,]+,\s*"([a-z_]+)"/g),
    ...all(read('packages/terminal-daemon/src/peer-delivery.ts'), /markUncertain\([^,]+,\s*"([a-z_]+)"/g),
    ...all(read('packages/workspace-store/src/peer-messages.ts'), /reason=["']([a-z_]+)["']/g),
  ]);
  // `pending` 是入库时钉的初始值，不是阻塞原因；`deliveryReason.ts` 顶部讲了为什么。
  reasons.delete('pending');
  return reasons;
}

test('每个会显示给用户的投递原因都有一句人话', () => {
  const reasons = emittedReasons();
  assert.ok(reasons.size >= 20, `只数出 ${reasons.size} 个原因，扫描多半失效了——先修扫描`);
  const leaked = [...reasons].filter(reason => queuedText(reason).includes(reason)).sort();
  assert.deepEqual(leaked, [],
    `这些原因没有说法，会把内部标识符原样显示给用户：\n  ${leaked.join('\n  ')}\n` +
    `在 packages/i18n/src/misc.ts 的 queuedReason 里加句子，再在 deliveryReason.ts 的 TEXT 里挂上。`);
});

test('认不出的原因仍然原样带出来，不假装知道它是什么', () => {
  // 兜底必须留着：扫描覆盖不到的路径上冒出新原因时，显示得难看好过显示得像是别的东西。
  assert.ok(queuedText('some_reason_from_the_future').includes('some_reason_from_the_future'));
  assert.equal(queuedText(null), queuedText('pending'), 'null 和 pending 都是「正常排队」');
});
