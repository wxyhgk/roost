import { t } from "@roost/i18n";
import type { ToolRowLabels } from "../../../vendor/dsh/chat/tool/ToolRow";

/**
 * 那批 vendor 积木要的全套文案，**拼一次、模块级复用**。
 *
 * 两个理由，都不是洁癖：
 *
 * 1. 组件没有 memo，每次渲染新建一个 labels 对象会让内部的格式化白算一遍；将来真把消息行
 *    memo 起来时，一个新对象会让 memo 彻底失效。
 * 2. `ToolRowLabels` 里那五套积木文案是**必填**的。可选的话，「传了 diff 卡片但忘了 diff
 *    labels」就变成一次静默的空渲染——而这一层最不该发生的就是卡片悄悄消失。拼在一处，
 *    漏一个是 tsc 当场报错。
 */
const b = t.misc.blocks;

const diff = {
  copy: b.copy, copied: b.copied,
  collapse: b.collapse, collapseAria: b.collapseAria,
  expand: b.expand, expandAria: b.expandAria,
  files: b.files,
};

const read = {
  window: b.window, copy: b.copy, copied: b.copied,
  collapse: b.collapse, collapseAria: b.collapseAria,
  expand: b.expand, expandAria: b.expandAria,
};

export const TERMINAL_LABELS = {
  signal: b.signal, exitCode: b.exitCode,
  running: b.running, failed: b.failed, done: b.done,
  noOutput: b.noOutput,
  copy: b.copy, copied: b.copied,
  collapse: b.collapse, collapseAria: b.collapseAria,
  expand: b.expand, expandAria: b.expandAria,
};

const search = {
  pathsSummary: b.pathsSummary, matchesSummary: b.matchesSummary,
  copy: b.copy, copied: b.copied, noResults: b.noResults,
  collapse: b.collapse, collapseAria: b.collapseAria,
  expand: b.expand, expandAria: b.expandAria,
};

const web = {
  noResults: b.noResults, sourcesTruncated: b.sourcesTruncated,
  http: b.http, contentTruncated: b.contentTruncated,
  markdown: {
    code: { copyLabel: b.copy, copiedLabel: b.copied },
    footnotes: t.misc.conversations.detail.footnotes,
  },
};

export const TOOL_ROW_LABELS: ToolRowLabels = {
  running: b.running, failed: b.failed, stopped: b.stopped,
  input: b.input, output: b.output, inspect: b.inspect,
  copy: b.copy, copied: b.copied,
  diff, read, search, terminal: TERMINAL_LABELS, web,
};
