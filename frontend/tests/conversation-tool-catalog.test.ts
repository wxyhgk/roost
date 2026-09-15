import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyTool } from '../src/features/conversations/tools/identify.ts';
import {
  TOOL_TITLE_EN, UNKNOWN_TOOL, toolCatalogEntry, toolTitle,
  type ToolCatalogEntry,
} from '../src/features/conversations/tools/catalog.ts';

/** 从 wire 名一路走到外观，和 registry.tsx 将来那一行是同一条路。 */
const look = (name: string): ToolCatalogEntry => toolCatalogEntry(identifyTool(name));

test('七家 CLI 的同一件事落到同一套外观', () => {
  /*
    拼法来自七家各自的 transcript（解析器不归一化，name 是原样写进去的）：
    claude 写 Bash、codex 写 shell、grok 的 ACP kind 是 execute、
    gemini / qwen 写 run_shell_command、opencode 写 bash。
    落不到一起的症状不是报错，是那家 CLI 的这一行显示泛型图标——所以必须钉住。
  */
  for (const name of ['Bash', 'shell', 'execute', 'CodexBash', 'run_terminal_cmd', 'run_shell_command', 'bash']) {
    assert.deepEqual(look(name), { variant: 'bash', icon: 'terminal', titleKey: 'terminal' }, name);
  }
  for (const name of ['Edit', 'edit', 'str_replace_editor', 'replace']) {
    assert.deepEqual(look(name), { variant: 'edit', icon: 'edit', titleKey: 'editFile' }, name);
  }
  for (const name of ['Read', 'read', 'view', 'read_file']) {
    assert.deepEqual(look(name), { variant: 'read', icon: 'read', titleKey: 'readFile' }, name);
  }
});

test('改文件的三种说法各有各的标题，但都不是泛型行', () => {
  // codex 的 apply_patch 和 claude 的 Edit 都是 edit 变体，标题不同：一个是补丁、一个是改一处。
  assert.deepEqual(look('apply_patch'), { variant: 'edit', icon: 'edit', titleKey: 'applyChanges' });
  assert.deepEqual(look('CodexPatch'), { variant: 'edit', icon: 'edit', titleKey: 'applyChanges' });
  assert.deepEqual(look('CodexDiff'), { variant: 'edit', icon: 'edit', titleKey: 'viewDiff' });
  assert.deepEqual(look('Write'), { variant: 'write', icon: 'write', titleKey: 'writeFile' });
  // 删除是唯一一个换字形的改文件动作。
  assert.deepEqual(look('Delete').icon, 'delete');
  assert.deepEqual(look('remove').icon, 'delete');
});

test('搜索一族：变体统一，标题区分搜文件名还是搜内容', () => {
  assert.deepEqual(look('Grep'), { variant: 'search', icon: 'search', titleKey: 'searchContent' });
  // 别名表把裸 search 收成 grep，所以它跟 Grep 同一行。
  assert.deepEqual(look('search'), look('Grep'));
  assert.deepEqual(look('search_file_content'), look('Grep'));
  assert.equal(look('Glob').titleKey, 'searchFiles');
  assert.equal(look('LS').titleKey, 'listFiles');
  assert.equal(look('list_directory').titleKey, 'listFiles');
});

test('上网的两个：变体留着，图标换成地球', () => {
  /*
    变体不能改成 others——WebFetch 的正文确实是读回来的一篇东西、WebSearch 确实是一串结果，
    variant 是 ToolRow 的版式开关。换的只有字形：「这是网上的」比「这是一次读」更该先看出来。
  */
  assert.deepEqual(look('WebFetch'), { variant: 'read', icon: 'web', titleKey: 'fetchUrl' });
  assert.deepEqual(look('web_fetch'), look('WebFetch'));
  assert.deepEqual(look('fetch'), look('WebFetch'));
  assert.deepEqual(look('WebSearch'), { variant: 'search', icon: 'web', titleKey: 'webSearch' });
  assert.deepEqual(look('google_web_search'), look('WebSearch'));
});

test('不动文件也不跑命令的那几类：others 变体 + 自己的字形', () => {
  assert.deepEqual(look('TodoWrite'), { variant: 'others', icon: 'todo', titleKey: 'todoList' });
  // codex 的 update_plan 是一张带状态的步骤表，画出来就是清单，所以跟 todo 一组。
  assert.deepEqual(look('update_plan'), look('TodoWrite'));
  assert.deepEqual(look('think'), { variant: 'others', icon: 'think', titleKey: 'reasoning' });
  assert.equal(look('ExitPlanMode').icon, 'plan');
  assert.equal(look('exit_plan_mode').icon, 'plan');
  assert.equal(look('AskUserQuestion').icon, 'question');
  assert.equal(look('Task').icon, 'task');
});

test('MCP：一律插件图标，标题留给 toolLabel', () => {
  /*
    前缀规则先于一切（和 happier 的 getToolViewComponent 同序）：一个 MCP 工具可能正好叫
    read，但那是别人家的 read，按本地 read 画就是在替它作保。
    标题必须是 null——「服务器 · 工具」才是它唯一有用的名字，固定标题会把那条信息盖掉。
  */
  assert.deepEqual(look('mcp__a__b'), { variant: 'others', icon: 'plugin', titleKey: null });
  assert.deepEqual(look('mcp__workspace_messaging__agent_send'), look('mcp__a__b'));
  // 名字正好和本地工具撞车也不许落到本地那一行。
  assert.deepEqual(look('mcp__srv__read'), look('mcp__a__b'));
});

test('认不出来落兜底，不崩', () => {
  // 空名是真实情况：配不上调用的孤儿结果，name 就是空串。
  assert.deepEqual(look(''), UNKNOWN_TOOL);
  assert.deepEqual(look('   '), UNKNOWN_TOOL);
  assert.deepEqual(look('some_tool_nobody_has_heard_of'), UNKNOWN_TOOL);
  assert.deepEqual(look('__proto__'), UNKNOWN_TOOL, '原型链上的键不算命中');
  assert.deepEqual(look('constructor'), UNKNOWN_TOOL);
  assert.deepEqual(look('toString'), UNKNOWN_TOOL);
  // 兜底就是这次改动之前每一行的样子：泛型图标 + others + 不改标题。
  assert.deepEqual(UNKNOWN_TOOL, { variant: 'others', icon: 'generic', titleKey: null });
});

test('标题：有键取词条，没键退回工具名', () => {
  assert.equal(toolTitle(look('Bash').titleKey, 'Bash'), 'Terminal');
  // MCP 和认不出来的工具都退回调用方给的名字（registry 那边是 toolLabel 拼的「服务器 · 工具」）。
  assert.equal(toolTitle(look('mcp__a__b').titleKey, 'a · b'), 'a · b');
  assert.equal(toolTitle(look('whatever').titleKey, 'whatever'), 'whatever');
});

test('每个用得到的标题键都有词条——漏一个就是标题位空白', () => {
  for (const key of Object.keys(TOOL_TITLE_EN) as (keyof typeof TOOL_TITLE_EN)[]) {
    assert.ok(TOOL_TITLE_EN[key].length > 0, key);
  }
  /*
    反过来也要钉：表里出现的每个键都必须在词条表里。类型上已经成立，但 TOOL_TITLE_EN 将来
    会被换成 i18n 那一份（键名是接口、文案不是），那时这条断言是唯一挡着漏译的东西。
  */
  const names = ['Bash', 'BashOutput', 'KillShell', 'Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'CodeSearch',
    'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'apply_patch', 'CodexDiff', 'Delete', 'WebFetch', 'WebSearch',
    'TodoWrite', 'think', 'ExitPlanMode', 'SwitchMode', 'AskUserQuestion', 'Task', 'SubAgent', 'change_title',
    'run_code'];
  for (const name of names) {
    const key = look(name).titleKey;
    assert.notEqual(key, null, `${name} 该有标题`);
    assert.ok(key !== null && key in TOOL_TITLE_EN, `${name} 的键 ${String(key)} 没有词条`);
  }
});
