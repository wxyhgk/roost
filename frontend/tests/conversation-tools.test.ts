import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyTool, toolArgsOf, argString, toolSubject } from '../src/features/conversations/tools/identify.ts';
import type { Block } from '../src/features/conversations/parts.ts';

const tool = (args: string, name = 'X'): Extract<Block, { kind: 'tool' }> =>
  ({ kind: 'tool', id: '1', name, args, result: null, failed: false });

test('同一件事的不同拼写归到同一个键', () => {
  // Claude 写 Edit，opencode 写 edit，codex 写 apply_patch——注册表只该认一个键。
  assert.equal(identifyTool('Edit').key, 'edit');
  assert.equal(identifyTool('edit').key, 'edit');
  assert.equal(identifyTool('Bash').key, 'bash');
  assert.equal(identifyTool('shell').key, 'bash');
  assert.equal(identifyTool('CodexBash').key, 'bash');
  assert.equal(identifyTool('apply_patch').key, 'patch');
  assert.equal(identifyTool('Read').key, 'read');
});

test('MCP 工具拆成服务器 + 工具名，全部归到一个键', () => {
  /*
    Claude 把整串 mcp__<服务器>__<工具> 原样写进 name。不拆的话它永远匹配不到渲染器；
    拆开之后所有 MCP 工具可以由一个渲染器统一接管。
  */
  const id = identifyTool('mcp__workspace_messaging__agent_send');
  assert.deepEqual(id, { server: 'workspace_messaging', tool: 'agent_send', key: 'mcp' });
  // 工具名里本来就带 __ 的，只剥服务器那一段。
  assert.equal(identifyTool('mcp__srv__a__b').tool, 'a__b');
});

test('空名不炸——孤儿结果的 name 就是空串', () => {
  assert.deepEqual(identifyTool(''), { server: null, tool: '', key: '' });
  assert.deepEqual(identifyTool('   '), { server: null, tool: '', key: '' });
});

test('参数：只有完整 JSON 对象才解得出，预览态解不出', () => {
  // codex / gemini / opencode 存完整 JSON。
  const full = toolArgsOf(tool('{"file_path":"/a/b.ts","old_string":"x"}'));
  assert.equal(argString(full, 'file_path'), '/a/b.ts');
  // claude / qwen / omp 是预览态，只剩一个标量。
  const preview = toolArgsOf(tool('npm test'));
  assert.equal(preview.json, null, '解不出来是常态，不是异常');
  assert.equal(preview.raw, 'npm test');
  // 半截 JSON（被上游截断过）不能让渲染器崩。
  assert.equal(toolArgsOf(tool('{"file_path":"/a/b')).json, null);
  // 数组和标量也当没解出来：没有字段可读。
  assert.equal(toolArgsOf(tool('[1,2,3]')).json, null);
  assert.equal(toolArgsOf(tool('')).raw, '');
});

test('主语：预览态下参数原文本身就是主语', () => {
  /*
    解析器按 command ?? file_path ?? path 的顺序挑那个唯一保留的标量，
    所以预览态的 raw 就是命令或路径本身。
  */
  assert.equal(toolSubject(toolArgsOf(tool('npm test'))), 'npm test');
  assert.equal(toolSubject(toolArgsOf(tool('{"command":"ls -la"}'))), 'ls -la');
  assert.equal(toolSubject(toolArgsOf(tool('{"file_path":"/a/b.ts"}'))), '/a/b.ts');
  // 有 JSON 但没有认识的字段：不要把整串 JSON 当主语显示。
  assert.equal(toolSubject(toolArgsOf(tool('{"todos":[]}'))), null);
});

import { rendererNameFor } from '../src/features/conversations/tools/registry.tsx';
import { tailText } from '../src/features/conversations/tools/text.ts';

const patch = { filePath: 'a.ts', truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] };

test('分派：认得出该认的，认不出的一律落兜底', () => {
  // patch 按数据认领，不看名字——谁带 patch 是 Claude 按 structuredPatch 决定的。
  assert.equal(rendererNameFor({ ...tool(''), name: '随便什么', patch } as never), 'patch');
  assert.equal(rendererNameFor({ ...tool('npm test'), name: 'Bash' }), 'bash');
  assert.equal(rendererNameFor({ ...tool('npm test'), name: 'shell' }), 'bash', 'codex 叫 shell');
  assert.equal(rendererNameFor({ ...tool('{"command":"ls"}'), name: 'bash' }), 'bash');
  assert.equal(rendererNameFor({ ...tool(''), name: 'mcp__srv__do' }), 'mcp');

  // 兜底：没有渲染器时返回 null，调用方走改动之前那条路，行为零差异。
  assert.equal(rendererNameFor({ ...tool('x'), name: 'Grep' }), null);
  assert.equal(rendererNameFor({ ...tool(''), name: '' }), null, '孤儿结果没有名字');
});

test('数据不够就不认领——认领了画不出来比不认领更糟', () => {
  // Claude 预览态下 Grep 这类工具连参数都不留；Bash 没有命令就只是个空壳。
  assert.equal(rendererNameFor({ ...tool(''), name: 'Bash' }), null, '没有命令不该认领');
  assert.equal(rendererNameFor({ ...tool('{"todos":[]}'), name: 'Bash' }), null, 'JSON 里没有 command');
  // patch 存在但 hunks 是空的：>128KB 的消息会被清空 hunks 只留 truncated。
  assert.equal(rendererNameFor({ ...tool(''), name: 'Edit', patch: { hunks: [], truncated: true } } as never), null);
});

test('命令输出截断留尾部——报错和结论都在末尾', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const { text, clipped } = tailText(lines, 200);
  assert.equal(clipped, true);
  assert.ok(text.endsWith('line 99'), '尾巴必须留着');
  assert.ok(!text.includes('line 0\n'), '头部该被砍掉');
  assert.ok(text.startsWith('line '), '从完整的一行开始，不劈开一行');
  assert.deepEqual(tailText('short', 200), { text: 'short', clipped: false });
});
