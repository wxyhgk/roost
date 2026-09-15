import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyTool, toolArgsOf, argString, toolLabel, toolSubject, toolSummary } from '../src/features/conversations/tools/identify.ts';
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

const summary = (args: string) => toolSummary(toolArgsOf(tool(args)));

test('摘要行：有主语就用主语，那是最可读的一行', () => {
  assert.equal(summary('{"command":"npm test","timeout":120000}'), 'npm test');
  assert.equal(summary('{"file_path":"/a/b.ts","old_string":"x","new_string":"y"}'), '/a/b.ts');
  // Grep/Glob 两个字段都带，主语取模式不取目录：「搜 TODO」比「在 /src 里搜」有信息量。
  assert.equal(summary('{"pattern":"TODO","path":"/src"}'), 'TODO');
  assert.equal(summary('{"path":"/src"}'), '/src', 'LS 只有 path，不会被抢走');
  assert.equal(summary('{"pattern":"TODO"}'), 'TODO');
  assert.equal(summary('{"url":"https://example.com/x"}'), 'https://example.com/x');
  // 预览态：参数原文本身就是主语，不该被 k=v 那条路碰到。
  assert.equal(summary('npm run build'), 'npm run build');
});

test('摘要行：没有主语才退到 k=v，不显示花括号原文', () => {
  /*
    TodoWrite、绝大多数 MCP 工具都是这样：参数是结构化 JSON，但里面一个我们认识的主语字段
    都没有。直接显示原文就是一坨花括号，比预览态时代更难读。
  */
  assert.equal(summary('{"todos":[{"content":"a"}]}'), 'todos=[{"content":"a"}]');
  assert.equal(summary('{"query":"roost","limit":10,"safe":true}'), 'query=roost limit=10 safe=true');
  // 只取前三个键：键多的工具不该拼出好几屏。
  assert.equal(summary('{"a":1,"b":2,"c":3,"d":4,"e":5}'), 'a=1 b=2 c=3');
  // null / undefined 不写成 "null"，留空值即可——键名本身已经有信息。
  assert.equal(summary('{"cursor":null}'), 'cursor=');
});

test('摘要行：跳过下划线开头的内部字段', () => {
  // `_meta` 这类是各家 CLI 自己塞的，占位置且对用户没意义。
  assert.equal(summary('{"_meta":{"trace":"x"},"name":"roost"}'), 'name=roost');
  assert.equal(summary('{"_a":1,"_b":2,"_c":3,"real":"v"}'), 'real=v');
  // 全是内部字段：挤不出东西就返回 null，让调用方兜底。
  assert.equal(summary('{"_meta":1}'), null);
});

test('摘要行：单值和整串各有上限，长参数不撑破一行', () => {
  const long = 'x'.repeat(500);
  const one = summary(JSON.stringify({ blob: long }));
  assert.ok(one!.length <= 1 + 'blob='.length + 60, `单值截到 60：实际 ${one!.length}`);
  assert.ok(one!.endsWith('…'), '截过要看得出来');

  // 三个长值：单值上限之外，整串还有一道上限。
  const three = summary(JSON.stringify({ a: long, b: long, c: long }));
  assert.ok(three!.length <= 140, `整串截到 140：实际 ${three!.length}`);
  assert.ok(three!.endsWith('…'));

  // 换行塌成空格：摘要行是单行，不塌的话字符预算全花在看不见的空白上。
  assert.equal(summary(JSON.stringify({ body: 'a\n\nb   c' })), 'body=a b c');
});

test('摘要行：参数为空 / 非对象 / 半截 JSON 都不崩，只是没有摘要', () => {
  // 三样全缺（孤儿结果 + 还在跑）也要有答案，兜底那条路靠的就是这个 null。
  assert.equal(summary(''), null);
  assert.equal(summary('   '), null, '只有空白等于没有参数');
  assert.equal(summary('{}'), null, '空对象挤不出键');
  assert.equal(summary('[1,2,3]'), '[1,2,3]', '数组当预览态标量，原样顶着');
  assert.equal(summary('{"file_path":"/a/b'), '{"file_path":"/a/b', '半截 JSON 解不出，当预览态原文');
});

// 判定住在 dispatch.ts：registry.tsx 里的 vendor 组件带 CSS Module，node --test 加载不了 .css。
import { rendererNameFor } from '../src/features/conversations/tools/dispatch.ts';
import { clipMiddle } from '../src/features/conversations/tools/text.ts';

const patch = { filePath: 'a.ts', truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] };

test('分派：认得出该认的，认不出的一律落兜底', () => {
  // patch 按数据认领，不看名字——谁带 patch 是 Claude 按 structuredPatch 决定的。
  assert.equal(rendererNameFor({ ...tool(''), name: '随便什么', patch } as never), 'patch');
  assert.equal(rendererNameFor({ ...tool('npm test'), name: 'Bash' }), 'bash');
  assert.equal(rendererNameFor({ ...tool('npm test'), name: 'shell' }), 'bash', 'codex 叫 shell');
  assert.equal(rendererNameFor({ ...tool('{"command":"ls"}'), name: 'bash' }), 'bash');
  /*
    MCP **不再有专用渲染器**：它要做的事（显示「服务器 · 工具」短名 + 摘要）兜底本来就全做
    ——`toolLabel` 会拆 `mcp__a__b`，`toolSummary` 会挤出一行。一个只是换了文案的渲染器
    不值得单独存在，而且多一条规则就多一处可能和兜底不一致的地方。
  */
  assert.equal(rendererNameFor({ ...tool(''), name: 'mcp__srv__do' }), null);
  assert.equal(toolLabel(identifyTool('mcp__srv__do'), 'mcp__srv__do'), 'srv · do', '短名由兜底负责');

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

test('长输出掐中间，两头都留', () => {
  /*
    只留尾部的话开头就没了，而开头有「跑的是什么、前几行报了什么」；最没用的是中间那截
    重复的进度行。同样的预算，留两头信息量更高。
  */
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const { text, clipped } = clipMiddle(lines, 200);
  assert.equal(clipped, true);
  assert.ok(text.startsWith('line 0'), '开头必须留着');
  assert.ok(text.endsWith('line 99'), '结论在末尾，尾巴也必须留着');
  assert.ok(/中间省略 \d+ 字符/.test(text), '砍掉多少要自己报数');
  assert.ok(!text.includes('line 50'), '中间那截该被砍掉');
  assert.deepEqual(clipMiddle('short', 200), { text: 'short', clipped: false });
});
