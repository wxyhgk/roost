/*
  真机抓下来的画面帧，回放一遍。

  **这一层用来接住 CLI 改界面。** 判定输入框靠的是几条按版本实测积累的规则（`❯` 行、
  上下横线、页脚关键词），而规则会漂：2026-09-22 claude 的页脚从 `accept edits` 一类
  变成 `auto mode on`，白名单一条都不命中，画面被判成「认不出」，于是从网页发出的消息
  **静默地**再也写不进终端——当时没有任何一条用例会失败，是靠人去翻日志才发现的。

  手写的 fixture 接不住这种事：它写的是我们**以为**的界面。所以这些帧由
  `scripts/observe.mjs --capture <名字>` 从真实终端抓取，只截输入框那一块
  （边框、`❯`、页脚），不带当时的工作内容。

  CLI 升级之后重抓一次：判定变了，这里就会红，而且直接把新旧两份画面摆出来。
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {classifyClaudeComposer} from '../src/claude-screen.ts';

type Frame = {cli: string | null; capturedAt: string; cols: number; cursorY: number; cursorX: number;
  expect: string; lines: string[]};

const dir = new URL('./screens/', import.meta.url).pathname;
const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();

test('抓下来的真实画面，判定要和抓的时候一致', () => {
  assert.ok(files.length > 0,
    '一帧都没有——这条用例成了空过。用 scripts/observe.mjs --capture 抓一帧回来');
  for (const name of files) {
    const frame = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Frame;
    const actual = classifyClaudeComposer(frame.lines, frame.cursorY, frame.cursorX, true);
    assert.equal(actual, frame.expect,
      `${name}（${frame.cli} · ${frame.capturedAt} · ${frame.cols} 列）判成了 ${actual}，` +
      `抓的时候是 ${frame.expect}。\n画面：\n${frame.lines.map(l => '  |' + l).join('\n')}\n` +
      `如果是 CLI 换了界面，重抓一帧并确认新判定是对的；如果不是，那就是判定规则被改坏了。`);
  }
});

/*
  同一块画面，把页脚那一行换成没见过的措辞——**必须仍然认得出**。

  这是上面那次漂移留下的教训做成的用例：真实帧只能证明「今天这一版认得出」，
  证明不了「明天换个说法还认得出」。而那正是代价最大的失败模式：不报错，只是不写。
*/
test('页脚换个没见过的说法，只要模式指示符还在就得认得出', () => {
  const frame = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Frame;
  const footer = frame.lines.findIndex(line => line.includes('⏵⏵'));
  assert.ok(footer >= 0, `${files[0]} 里没有 ⏵⏵ 指示符，这条用例要换一帧来做`);
  const renamed = frame.lines.map((line, i) => i === footer ? '  ⏵⏵ 某种还没出现过的模式 on' : line);
  assert.equal(classifyClaudeComposer(renamed, frame.cursorY, frame.cursorX, true), frame.expect);
});
